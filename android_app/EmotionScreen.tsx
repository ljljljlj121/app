import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View,
  useWindowDimensions, type NativeSyntheticEvent, type ViewProps,
} from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { useCameraPermissions } from "expo-camera";
import {
  appendFrames, visibleFrames, TAG_LABELS, STATUS_LABELS,
  type EmotionBatch, type EmotionFrame,
} from "./emotionHistory";
import { EmotionTimeline } from "./EmotionTimeline";

type NativeProps = ViewProps & {
  paused: boolean;
  front: boolean;
  acknowledged: string;
  onFrames: (event: NativeSyntheticEvent<EmotionBatch>) => void;
};
const NativeEmotionView = requireNativeViewManager<NativeProps>("EdgeEmotion");

export function EmotionScreen({ onBack }: { onBack: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
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
          <Text style={s.title}>实时情绪识别（边端）</Text>
          <Text style={s.muted}>本机单人脸 · 不保存、不上传画面</Text>
        </View>
      </View>
      <View style={[s.body, landscape && s.landscape]}>
        <View style={[s.camera, landscape && s.cameraLandscape]}>
          {permission?.granted && mounted ? (
            <NativeEmotionView key={`${front}:${retry}`} style={StyleSheet.absoluteFill} paused={paused} front={front}
              acknowledged={`${batch?.sessionId ?? ""}:${history[history.length - 1]?.frameId ?? 0}`}
              onFrames={({ nativeEvent }) => {
                historyRef.current = appendFrames(historyRef.current, nativeEvent);
                setHistory(historyRef.current);
                setBatch(nativeEvent);
              }} />
          ) : (
            <View style={s.permission}>
              <Text style={s.text}>{permission?.granted ? "正在切换摄像头…" : "需要摄像头权限；画面仅用于本地分析"}</Text>
              {!permission?.granted && <Pressable style={s.button} onPress={() => {
                if (permission?.canAskAgain === false) void Linking.openSettings();
                else void requestPermission();
              }}><Text style={s.buttonText}>{permission?.canAskAgain === false ? "打开系统设置" : "授权摄像头"}</Text></Pressable>}
            </View>
          )}
          <View style={s.badge} pointerEvents="none"><Text style={s.text}>{STATUS_LABELS[state] ?? state}</Text></View>
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
        </ScrollView>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#071a30", padding: 12, gap: 10 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 12 },
  heading: { flex: 1, gap: 4 }, title: { color: "#f2f7ff", fontSize: 18, fontWeight: "700" },
  body: { flex: 1, gap: 12 }, landscape: { flexDirection: "row" },
  camera: { flex: 1, minHeight: 160, overflow: "hidden", borderRadius: 16, backgroundColor: "#02070d" },
  cameraLandscape: { flex: 1.2 },
  panel: { flex: 1 }, panelContent: { gap: 5, paddingBottom: 8 },
  permission: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 20 },
  badge: { position: "absolute", top: 12, left: 12, right: 12, padding: 8, borderRadius: 9, backgroundColor: "#071a30cc" },
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
