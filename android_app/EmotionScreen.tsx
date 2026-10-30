import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState, BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View,
  useWindowDimensions, type NativeSyntheticEvent, type ViewProps,
} from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import {
  appendFrames, visibleFrames, TAG_LABELS, STATUS_LABELS,
  type EmotionBatch, type EmotionFrame,
} from "./emotionHistory";
import { EmotionTimeline } from "./EmotionTimeline";
import { SpeechResults, SpeechSettings, loadSpeechConfig, defaultSpeechConfig, type SpeechBatch, type SpeechConfig } from "./SpeechResults";

type NativeProps = ViewProps & {
  paused: boolean;
  front: boolean;
  acknowledged: string;
  speechConfig: string;
  onSpeech: (event: NativeSyntheticEvent<SpeechBatch>) => void;
  onFrames: (event: NativeSyntheticEvent<EmotionBatch>) => void;
};
const NativeEmotionView = requireNativeViewManager<NativeProps>("EdgeEmotion");

export function EmotionScreen({ onBack }: { onBack: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [microphone, requestMicrophone] = useMicrophonePermissions();
  const [speech, setSpeech] = useState<SpeechBatch | null>(null);
  const [config, setConfig] = useState<SpeechConfig>(defaultSpeechConfig);
  const [configReady, setConfigReady] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [paused, setPaused] = useState(false);
  const [front, setFront] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [retry, setRetry] = useState(0);
  const [batch, setBatch] = useState<EmotionBatch | null>(null);
  const [history, setHistory] = useState<EmotionFrame[]>([]);
  const [windowMs, setWindowMs] = useState(3000);
  const historyRef = useRef<EmotionFrame[]>([]);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  useEffect(() => {
    let alive = true;
    void loadSpeechConfig().then(value => { if (alive) setConfig(value); })
      .catch(() => undefined).finally(() => { if (alive) setConfigReady(true); });
    const listener = AppState.addEventListener("change", value => setForeground(value === "active"));
    return () => { alive = false; listener.remove(); };
  }, []);
  useEffect(() => {
    // Allow the collection CameraView teardown to commit before acquiring CameraX.
    const timer = setTimeout(() => setMounted(true), 250);
    return () => clearTimeout(timer);
  }, [front, retry]);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => { back.remove(); historyRef.current = []; };
  }, [onBack]);
  const frames = useMemo(() => visibleFrames(history, batch?.nowMs ?? 0, windowMs),
    [history, batch?.nowMs, windowMs]);
  const current = batch?.current;
  const state = paused ? "paused" : (batch?.state ?? "initializing");
  const switchLens = () => {
    historyRef.current = [];
    setHistory([]);
    setBatch(null);
    setSpeech(null);
    setFront((old) => !old);
    // A lens switch while paused also clears the frozen native window by remounting.
    setMounted(false);
  };
  const retryCamera = () => {
    historyRef.current = [];
    setHistory([]);
    setBatch(null);
    setPaused(false);
    setMounted(false);
    setRetry((old) => old + 1);
  };
  return (
    <View style={s.root}>
      <View style={s.toolbar}>
        <Pressable accessibilityRole="button" onPress={onBack} style={s.button}><Text style={s.buttonText}>返回</Text></Pressable>
        <View style={s.heading}>
          <Text style={s.title}>实时情绪识别</Text>
          <Text style={s.muted}>本机表情／离线转写 · 讲话片段暂存并上传云端，处理后删除</Text>
        </View>
      </View>
      <View style={s.permissionStatus}>
        <Text style={permission?.granted ? s.permissionOk : s.permissionWarn}>
          {permission?.granted ? "摄像头已授权" : "摄像头未授权"}
        </Text>
        <Text style={microphone?.granted ? s.permissionOk : s.permissionWarn}>
          {microphone?.granted ? "麦克风已授权" : "麦克风未授权"}
        </Text>
        <Text style={s.permissionState}>
          {speech?.state ? (speech?.state === "listening" ? "正在监听语音" : `语音状态：${speech.state}`) : "尚未启动语音监听"}
        </Text>
      </View>
      <View style={[s.body, landscape && s.landscape]}>
        <View style={[s.camera, landscape && s.cameraLandscape]}>
          {permission?.granted && microphone?.granted && mounted && configReady ? (
            <NativeEmotionView key={`${front}:${retry}`} style={StyleSheet.absoluteFill} paused={paused || !foreground} front={front}
              speechConfig={JSON.stringify(config)} onSpeech={({ nativeEvent }) => setSpeech(nativeEvent)}
              acknowledged={`${batch?.sessionId ?? ""}:${history[history.length - 1]?.frameId ?? 0}`}
              onFrames={({ nativeEvent }) => {
                historyRef.current = appendFrames(historyRef.current, nativeEvent);
                setHistory(historyRef.current);
                setBatch(nativeEvent);
              }} />
          ) : (
            <View style={s.permission}>
              <Text style={s.text}>{permission?.granted && microphone?.granted ? "正在准备摄像头和麦克风…" : "需要摄像头与麦克风权限；讲话片段将暂存并上传云端"}</Text>
              {(!permission?.granted || !microphone?.granted) && <Pressable style={s.button} onPress={() => {
                void (async () => {
                  if (permission?.canAskAgain === false || microphone?.canAskAgain === false) { await Linking.openSettings(); return; }
                  if (!permission?.granted) await requestPermission();
                  if (!microphone?.granted) await requestMicrophone();
                })();
              }}><Text style={s.buttonText}>授权摄像头和麦克风</Text></Pressable>}
            </View>
          )}
          <View style={s.badge} pointerEvents="none"><Text style={s.text}>{STATUS_LABELS[state] ?? state}</Text></View>
          {!paused && foreground && speech?.recordingId && <View style={s.cloudBadge} pointerEvents="none">
            <Text style={s.text}>云端：录制中 · #{speech.recordingId}</Text>
          </View>}
          <View style={s.prediction} pointerEvents="none">
            <Text style={s.tag}>{current?.tag ? `${TAG_LABELS[current.tag]} / ${current.tag}` : "—"}</Text>
            <Text style={s.text}>
              {current?.tag && current.confidence !== null ? `置信度 ${(current.confidence * 100).toFixed(1)}% · 原始 argmax` : "当前无有效预测"}
            </Text>
            {current?.probabilities && <Text style={s.muted}>
              正 {(current.probabilities[0] * 100).toFixed(1)}%　负 {(current.probabilities[1] * 100).toFixed(1)}%　中 {(current.probabilities[2] * 100).toFixed(1)}%
            </Text>}
          </View>
        </View>
        <ScrollView style={s.panel} contentContainerStyle={s.panelContent}>
          <View style={s.actions}>
            <Pressable style={s.button} onPress={() => setPaused((old) => !old)}><Text style={s.buttonText}>{paused ? "恢复 · 新会话" : "暂停"}</Text></Pressable>
            <Pressable style={s.button} onPress={switchLens}><Text style={s.buttonText}>{front ? "切换后置" : "切换前置"}</Text></Pressable>
            {state === "camera_error" && <Pressable style={s.button} onPress={retryCamera}>
              <Text style={s.buttonText}>重试摄像头</Text>
            </Pressable>}
          </View>
          <Text style={s.text}>分析 {batch?.analysisFps.toFixed(1) ?? "0.0"} FPS · 已分析 {batch?.analyzedFrames ?? 0} 帧</Text>
          <Text style={s.muted}>
            采集→结果 P95 {batch?.captureLatencyP95Ms != null ? `${batch.captureLatencyP95Ms.toFixed(0)} ms` : "不可测"}
            {" · "}本帧处理 {current?.processingMs ?? "—"} ms
          </Text>
          {!!batch?.detail && <Text style={s.error}>{batch.detail}</Text>}
          {!!current?.error && <Text selectable style={s.error}>{current.error}</Text>}
          <View style={s.windowHeader}>
            <Text style={s.text}>原始帧窗口 · 最近 {windowMs / 1000} 秒</Text>
            <Pressable accessibilityRole="button" onPress={() => setWindowMs((old) => old === 3000 ? 30000 : 3000)}>
              <Text style={s.link}>查看 {windowMs === 3000 ? "30" : "3"} 秒</Text>
            </Pressable>
          </View>
          <Text style={s.muted}>{frames.length} 帧 · 每格一帧 · 左右滑动，点击查看 · {paused ? "已暂停" : "实时更新"}</Text>
          <EmotionTimeline key={`${front}:${retry}:${batch?.sessionId ?? ""}`}
            frames={frames} nowMs={batch?.nowMs ?? 0} paused={paused} />
          <Text style={s.muted}>内存 {history.length}/900 条 · 最多 30 秒 · 原始 tag，未平滑</Text>
          <Text style={s.muted}>背压丢帧估计 {batch?.backpressureDroppedEstimate ?? 0}（含在途帧）</Text>
          <SpeechResults batch={speech} />
          <SpeechSettings value={config} onSave={setConfig} paused={paused} />
          {!config.key && <Text style={s.muted}>请暂停后在设置中填写云端 API Key。本机识别可独立工作。</Text>}
        </ScrollView>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#071a30", padding: 12, gap: 10 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 12 },
  permissionStatus: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, paddingHorizontal: 4 },
  permissionOk: { color: "#86efb5", fontSize: 11 }, permissionWarn: { color: "#ffb3a7", fontSize: 11 },
  permissionState: { color: "#b8cce2", fontSize: 11 },
  heading: { flex: 1, gap: 4 }, title: { color: "#f2f7ff", fontSize: 18, fontWeight: "700" },
  body: { flex: 1, gap: 12 }, landscape: { flexDirection: "row" },
  camera: { flex: 1, minHeight: 160, overflow: "hidden", borderRadius: 16, backgroundColor: "#02070d" },
  cameraLandscape: { flex: 1.2 },
  panel: { flex: 1 }, panelContent: { gap: 5, paddingBottom: 8 },
  permission: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 20 },
  badge: { position: "absolute", top: 12, left: 12, right: 12, padding: 8, borderRadius: 9, backgroundColor: "#071a30cc" },
  cloudBadge: { position: "absolute", top: 55, left: 12, right: 12, padding: 8, borderRadius: 9, backgroundColor: "#864214dd" },
  prediction: { position: "absolute", bottom: 12, left: 12, right: 12, backgroundColor: "#071a30dd", borderRadius: 12, padding: 12, gap: 5 },
  tag: { color: "#41d9ed", fontSize: 24, fontWeight: "700" },
  text: { color: "#e6f0ff", fontSize: 13 }, muted: { color: "#9ab2ce", fontSize: 11 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 5 },
  button: { backgroundColor: "#1264c4", paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#ff9aa4", fontSize: 12 },
  windowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  link: { color: "#41d9ed", padding: 5, fontSize: 12 },
});
