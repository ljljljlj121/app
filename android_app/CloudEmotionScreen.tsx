import React, { useEffect, useRef, useState } from "react";
import { AppState, NativeModules, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { DEFAULT_MER_BASE, DEFAULT_MER_MODEL, inferEmotion } from "./cloudEmotion";
import { SpeechGate } from "./speechGate";
import { runVoiceLoop } from "./voiceLoop";

const Recorder = NativeModules.WavRecorder as {
  startMonitoring(): Promise<string>;
  beginRecording(): Promise<void>;
  stopCapture(trim: number): Promise<{path: string}>;
  getRms(): Promise<number>;
  readFileBase64(path: string): Promise<string>;
  deleteFile(path: string): Promise<void>;
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const labels: Record<string, string> = {happy:"😊 开心", sad:"😢 悲伤", angry:"😠 愤怒", fear:"😨 恐惧", disgust:"🤢 厌恶", surprise:"😲 惊讶", neutral:"😐 平静"};

// Own camera, microphone, sequential voice recognition, cancellation, and settings; no dataset upload state.
export function CloudEmotionScreen({onBusyChange}: {onBusyChange: (busy: boolean) => void}) {
  const camera = useRef<CameraView>(null);
  const [permission, requestCameraPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState("就绪，点击开始后持续等待你说话");
  const [result, setResult] = useState("尚无识别结果");
  const [metrics, setMetrics] = useState("");
  const [error, setError] = useState("");
  const [base, setBase] = useState(DEFAULT_MER_BASE);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MER_MODEL);
  const [threshold, setThreshold] = useState("200");
  const active = useRef(false);
  const mounted = useRef(true);
  const captureBusy = useRef(false);
  const admission = useRef(false);
  const session = useRef(0);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);

  const stop = () => {
    if (!active.current && !captureBusy.current) return;
    active.current = false;
    session.current++;
    request.current?.abort();
    if (mounted.current) {
      setRunning(false);
      setStopping(captureBusy.current);
      setStatus("已停止，正在释放资源…");

    }
  };
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", state => { if (state !== "active") stop(); });
    return () => { mounted.current = false; stop(); listener.remove(); };
  }, []);

  const runSession = async () => {
    if (active.current || captureBusy.current) return;
    if (!Recorder?.startMonitoring || !Recorder?.beginRecording) { setError("请安装包含原生录音模块的新版 APK"); return; }
    const energy = Number(threshold);
    if (!/^https?:\/\//.test(base.trim()) || !model.trim() || !key.trim() || !Number.isFinite(energy) || energy <= 0) {
      setError("请检查推理地址、Key、模型及音量门槛"); return;
    }
    if (!permission?.granted && !(await requestCameraPermission()).granted) return;
    if (Platform.OS === "android" && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO) !== PermissionsAndroid.RESULTS.GRANTED) {
      setError("需要麦克风权限"); return;
    }
    if (!mounted.current) return;
    // Capture can start only once preview has mounted following permission grant.
    if (!ready || !camera.current) { setError("摄像头正在准备，请稍后点击开始"); return; }
    const config = {base:base.trim(), key:key.trim(), model:model.trim()};
    active.current = true;
    captureBusy.current = true;
    onBusyChange(true);
    const generation = ++session.current;
    setRunning(true); setError(""); setMetrics(""); setResult("等待本次检测结果");
    try {
      await runVoiceLoop(() => active.current && generation === session.current, async () => {
        let audioStarted = false;
        let recordingStarted = false;
        let videoPath: string | undefined;
        let audioPath: string | undefined;
        let videoPromise: ReturnType<CameraView["recordAsync"]> | undefined;
        let phase = "录制";
        try {
          await Recorder.startMonitoring(); audioStarted = true;
          // Listening computes RMS only; no accumulating audio/video file while idle.
          const gate = new SpeechGate(energy);
          let outcome = gate.state;
          while (active.current && generation === session.current && !gate.spoken) {
            await pause(100);
            const rms = await Recorder.getRms();
            outcome = gate.feed(rms, Date.now());
            if (mounted.current) setStatus(`等待说话，可按停止结束 · 音量 ${Math.round(rms)} / ${energy}`);
          }
          if (!active.current || generation !== session.current) return;
          const started = Date.now();
          videoPromise = camera.current!.recordAsync({maxDuration:16}); recordingStarted = true;
          void videoPromise.catch(() => undefined);
          await Recorder.beginRecording();
          while (active.current && generation === session.current) {
            await pause(100);
            const rms = await Recorder.getRms();
            outcome = gate.feed(rms, Date.now());
            if (mounted.current) setStatus(`正在录制，停顿后上传识别 · 音量 ${Math.round(rms)} / ${energy}`);
            if (outcome === "speech" || outcome === "speech_limit") break;
          }
          const endedAt = Date.now();
          camera.current?.stopRecording(); recordingStarted = false;
          const stopped = Recorder.stopCapture(0).then(audio => { audioPath = audio.path; return audio; });
          audioStarted = false;
          void stopped.catch(() => undefined);
          const [video, audio] = await Promise.all([videoPromise, stopped]);
          videoPath = video?.uri; audioPath = audio.path;
          if (!active.current || generation !== session.current) return;
          if (!videoPath) throw new Error("未生成录像文件");
          phase = "上传识别";
          setStatus(outcome === "speech_limit" ? "达到 15 秒上限，正在上传本次录音识别…" : "说话结束，正在上传识别…");
          const [videoData, audioData] = await Promise.all([Recorder.readFileBase64(videoPath), Recorder.readFileBase64(audioPath)]);
          if (!active.current || generation !== session.current) return;
          const controller = new AbortController();
          request.current = controller;
          const timer = setTimeout(() => controller.abort(), 60000);
          const requestedAt = Date.now();
          try {
            const number = ++sequence.current;
            const emotion = await inferEmotion({video:videoData, audio:audioData, id:number, kind:outcome}, config.base, config.key, config.model, controller.signal);
            if (mounted.current && active.current && generation === session.current) {
              setResult(`${labels[emotion]} · #${number} · ${new Date().toLocaleTimeString()}`);
              setMetrics(`录制 ${((endedAt-started)/1000).toFixed(1)}s · 请求 ${((Date.now()-requestedAt)/1000).toFixed(1)}s · 录制结束至结果 ${((Date.now()-endedAt)/1000).toFixed(1)}s`);
              setError("");
              setStatus("识别完成，正在返回监听…");
            }
          } finally { clearTimeout(timer); request.current = null; }
        } catch (e) {
          if (active.current && generation === session.current) {
            if (phase !== "上传识别") throw e;
            if (mounted.current) {
              setError(`本段识别失败：${String(e)}`);
              setStatus("识别失败，稍后返回监听…");
            }
            await pause(1000);
          }
        } finally {
          if (recordingStarted) camera.current?.stopRecording();
          if (audioStarted) {
            try { audioPath = (await Recorder.stopCapture(0)).path; } catch { /* retain first failure */ }
          }
          if (!videoPath && videoPromise) {
            try { videoPath = (await videoPromise)?.uri; } catch { /* recording failed */ }
          }
          for (const path of [videoPath, audioPath]) if (path) void Recorder.deleteFile(path).catch(() => undefined);
        }
      });
    } catch (e) {
      if (mounted.current && active.current && generation === session.current) setError(`采集失败，已停止：${String(e)}`);
    } finally {
      active.current = false;
      captureBusy.current = false;
      onBusyChange(false);
      if (mounted.current) { setRunning(false); setStopping(false); setStatus("已停止"); }
    }
  };

  const start = async () => {
    if (admission.current) return;
    admission.current = true;
    try { await runSession(); } finally { admission.current = false; }
  };

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>☁ 云端情感识别</Text>
    <Text style={styles.hint}>循环语音检测 · 说完后识别 · 完成后自动返回监听</Text>
    <View style={styles.preview}>
      {permission?.granted ? <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="front" mode="video" videoQuality="480p" videoBitrate={500000} mute mirror onCameraReady={() => setReady(true)} onMountError={e => {setError(e.message); stop();}} />
        : <Pressable onPress={() => void requestCameraPermission()}><Text style={styles.text}>点击开启摄像头</Text></Pressable>}
    </View>
    <Text style={styles.result}>{result}</Text>
    <Text style={styles.text}>{status}</Text>
    {!!metrics && <Text style={styles.hint}>{metrics}</Text>}
    {!!error && <Text style={styles.error}>{error}</Text>}
    <Pressable style={styles.button} disabled={stopping || (!running && !ready)} onPress={() => running ? stop() : void start()}>
      <Text style={styles.buttonText}>{stopping ? "正在停止…" : running ? "停止检测" : "开始循环语音检测"}</Text>
    </Pressable>
    <Text style={styles.hint}>开始后一直等待说话；录制和识别依次进行，结果返回后自动监听下一次。上传识别期间暂停监听，按停止结束整个循环。</Text>
    <Text style={styles.label}>推理 API 地址</Text><TextInput style={styles.input} value={base} onChangeText={setBase} editable={!running && !stopping} autoCapitalize="none" />
    <Text style={styles.label}>API Key</Text><TextInput style={styles.input} value={key} onChangeText={setKey} editable={!running && !stopping} secureTextEntry />
    <Text style={styles.label}>模型名称</Text><TextInput style={styles.input} value={model} onChangeText={setModel} editable={!running && !stopping} autoCapitalize="none" />
    <Text style={styles.label}>音量门槛（RMS）</Text><TextInput style={styles.input} value={threshold} onChangeText={setThreshold} editable={!running && !stopping} keyboardType="numeric" />
    <Text style={styles.hint}>单次讲话录制最长 15 秒（不含等待开口时间），达到上限后上传一次。请求耗时包含上传、服务端等待、模型推理和下载。</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page:{padding:16, gap:12, paddingBottom:40}, title:{fontSize:22,fontWeight:"700",color:"#e2efff"},
  hint:{color:"#91abc5",fontSize:13,lineHeight:20}, text:{color:"#d3e7fa",fontSize:15},
  preview:{height:250,aspectRatio:3/4,alignSelf:"center",backgroundColor:"#102844",borderRadius:16,overflow:"hidden",alignItems:"center",justifyContent:"center"},
  result:{color:"#51def0",fontSize:23,fontWeight:"700"}, error:{color:"#ff8996"},
  label:{color:"#b9d0e5",fontSize:14}, input:{backgroundColor:"#102844",borderWidth:1,borderColor:"#284663",borderRadius:12,padding:12,color:"#e2efff"},
  button:{backgroundColor:"#1264c4",padding:16,borderRadius:12,alignItems:"center"},buttonText:{color:"white",fontWeight:"700",fontSize:17},
});
