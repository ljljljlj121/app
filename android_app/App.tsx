import AsyncStorage from "@react-native-async-storage/async-storage";
import { Video } from "expo-av";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ReviewMediaPlayer } from "./ReviewMediaPlayer";
import { getCapturePreviewSize } from "./captureLayout";
import { captureFormData, CaptureFiles } from "./captureUpload";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

type Mode = "face_only" | "av_vad";
type PendingCapture = CaptureFiles & { cleanupPaths: string[] };
type Sample = {
  id: string;
  created_at?: string;
  board_id?: string;
  review_count?: number;
  is_reviewed?: boolean;
  is_invalid?: boolean;
  has_audio?: boolean;
};
type Settings = {
  server: string;
  token: string;
  boardId: string;
  preDelay: string;
  vadSilence: string;
  vadThreshold: string;
  audioOffset: string;
};
type NativeWavRecorder = {
  startCapture(): Promise<string>;
  getRms(): Promise<number>;
  stopCapture(trimTailMs: number): Promise<{ path: string; durationMs: number; trimmedTailMs: number }>;
  trimVideoTail(videoPath: string, trimTailMs: number): Promise<string>;
  createSilentWav(durationMs: number): Promise<string>;
  mergeMedia(videoPath: string, wavPath: string, audioOffsetSeconds: number): Promise<string>;
  deleteFile(path: string): Promise<void>;
};

const NativeRecorder = NativeModules.WavRecorder as NativeWavRecorder | undefined;
const SERVER_DEFAULT = "http://183.62.69.210:9004";
const TOKEN_DEFAULT = "xzy123456!";
const EMOTIONS = [
  { key: "happy", label: "😊 开心" },
  { key: "sad", label: "😢 悲伤" },
  { key: "angry", label: "😠 愤怒" },
  { key: "fear", label: "😨 恐惧" },
  { key: "disgust", label: "🤢 厌恶" },
  { key: "surprise", label: "😲 惊讶" },
  { key: "neutral", label: "😐 平静" },
];
const STORAGE_KEY = "data-collection-settings-v1";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function makeDefaultSettings(): Settings {
  const suffix = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return {
    server: SERVER_DEFAULT,
    token: TOKEN_DEFAULT,
    boardId: `android-${suffix}`,
    preDelay: "3",
    vadSilence: "1.5",
    vadThreshold: "200",
    audioOffset: "0",
  };
}

function endpoint(server: string, path: string) {
  return `${server.replace(/\/+$/, "")}${path}`;
}

function AppButton({
  title,
  onPress,
  color = "#1169d8",
  disabled = false,
  small = false,
}: {
  title: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: disabled ? "#26364c" : color, opacity: pressed && !disabled ? 0.82 : 1 },
        small && styles.smallButton,
      ]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

function AppContent() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [captureViewport, setCaptureViewport] = useState({ width: 0, height: 0 });
  const landscape = windowWidth > windowHeight;
  const viewportWidth = captureViewport.width || Math.max(0, windowWidth - insets.left - insets.right);
  const viewportHeight = captureViewport.height || Math.max(0, windowHeight - insets.top - insets.bottom - 120);
  const previewSize = getCapturePreviewSize(viewportWidth, viewportHeight, landscape);
  const ControlsContainer = landscape ? ScrollView : View;
  const cameraRef = useRef<CameraView>(null);
  const reviewVideoRef = useRef<Video>(null);
  const reviewAudioRef = useRef<Video>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(makeDefaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"collect" | "review">("collect");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("就绪，请选择录制模式开始采集");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<Mode>("face_only");
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingCapture | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [reviewFilter, setReviewFilter] = useState<"pending" | "all">("pending");
  const [selectedSample, setSelectedSample] = useState<Sample | null>(null);
  const [reviewVideoFallback, setReviewVideoFallback] = useState(false);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [raw, token] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          SecureStore.getItemAsync("data-collection-token"),
        ]);
        if (!active) return;
        const base = makeDefaultSettings();
        const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
        setSettings({ ...base, ...stored, token: token ?? stored.token ?? TOKEN_DEFAULT });
      } catch {
        // Keep defaults so first launch works without a setup round trip.
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers ?? {});
      headers.set("X-Upload-Token", settings.token.trim());
      if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
      const response = await fetch(endpoint(settings.server, path), { ...init, headers });
      const bodyText = await response.text();
      let body: any = null;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = bodyText;
      }
      if (!response.ok) {
        throw new Error(body?.msg || body?.message || `服务器返回 ${response.status}`);
      }
      return body;
    },
    [settings.server, settings.token],
  );

  const saveSettings = useCallback(async () => {
    if (!settings.server.trim() || !settings.token.trim() || !settings.boardId.trim()) {
      Alert.alert("配置不完整", "服务器地址、访问令牌和设备编号都不能为空。");
      return;
    }
    const silence = Number(settings.vadSilence);
    const threshold = Number(settings.vadThreshold);
    const delay = Number(settings.preDelay);
    const audioOffset = Number(settings.audioOffset);
    if (!Number.isFinite(silence) || silence < 0.5 || silence > 6) {
      Alert.alert("设置无效", "语音停顿时长需在 0.5 到 6 秒之间。");
      return;
    }
    if (!Number.isFinite(threshold) || threshold < 1) {
      Alert.alert("设置无效", "声音阈值需为大于 0 的数值。");
      return;
    }
    if (!Number.isFinite(delay) || delay < 0 || delay > 10) {
      Alert.alert("设置无效", "准备倒计时需在 0 到 10 秒之间。");
      return;
    }
    if (!Number.isFinite(audioOffset) || audioOffset < -5 || audioOffset > 5) {
      Alert.alert("设置无效", "音频时间补偿需在 -5 到 5 秒之间。");
      return;
    }
    setSaveBusy(true);
    try {
      await Promise.all([
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, token: undefined })),
        SecureStore.setItemAsync("data-collection-token", settings.token.trim()),
      ]);
      setSettings((current) => ({ ...current, server: current.server.trim().replace(/\/+$/, ""), boardId: current.boardId.trim() }));
      setSettingsOpen(false);
      setStatus("设置已保存在本机");
      setError("");
    } catch (e) {
      Alert.alert("保存失败", messageOf(e));
    } finally {
      setSaveBusy(false);
    }
  }, [settings]);

  const requestMicPermission = useCallback(async () => {
    if (Platform.OS !== "android") return false;
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: "麦克风权限",
      message: "音视频采集需要使用手机麦克风录制语音并检测说话停顿。",
      buttonPositive: "允许",
      buttonNegative: "取消",
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }, []);

  const ensureCameraPermission = useCallback(async () => {
    if (cameraPermission?.granted) return true;
    const result = await requestCameraPermission();
    return result.granted;
  }, [cameraPermission?.granted, requestCameraPermission]);

  const uploadCapture = useCallback(
    async (videoUri: string, wavPath: string, mergedPath: string, hasAudio: boolean) => {
      setStatus("正在上传样本到远端服务器…");
      setProgress(92);
      const form = captureFormData({ videoUri, wavPath, mergedPath, hasAudio }, settings.boardId);
      const response = await fetch(endpoint(settings.server, "/api/upload_sample"), {
        method: "POST",
        headers: { "X-Upload-Token": settings.token.trim() },
        body: form,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`上传服务器返回了非 JSON 响应 (${response.status})`);
      }
      if (!response.ok || !body?.ok || !body.id) {
        throw new Error(body?.msg || `上传失败 (${response.status})`);
      }
      setUploadedId(body.id);
      setStatus(`上传成功 · ${body.id} · 请标注本次情绪`);
      setProgress(100);
    },
    [settings.boardId, settings.server, settings.token],
  );

  const retryUpload = useCallback(async () => {
    if (!pendingUpload || busy) return;
    setBusy(true);
    setError("");
    try {
      await uploadCapture(pendingUpload.videoUri, pendingUpload.wavPath, pendingUpload.mergedPath, pendingUpload.hasAudio);
      setPendingUpload(null);
      for (const path of pendingUpload.cleanupPaths) void NativeRecorder?.deleteFile(path).catch(() => undefined);
    } catch (e) {
      setError(`上传失败：${messageOf(e)}`);
      setStatus("录制文件已保留，可重试上传");
    } finally {
      setBusy(false);
    }
  }, [pendingUpload, busy, uploadCapture]);

  const discardPendingUpload = useCallback(() => {
    if (busy || !pendingUpload) return;
    for (const path of pendingUpload.cleanupPaths) void NativeRecorder?.deleteFile(path).catch(() => undefined);
    setPendingUpload(null);
    setError("");
    setStatus("已丢弃未上传录制，可以重新录制");
    setProgress(0);
  }, [busy, pendingUpload]);

  const startCapture = useCallback(
    async (selectedMode: Mode) => {
      if (busy || recording || pendingUpload) return;
      setError("");
      setMode(selectedMode);
      const cameraOk = await ensureCameraPermission();
      if (!cameraOk) {
        Alert.alert("需要摄像头权限", "请在系统设置中允许本应用访问摄像头。 ");
        return;
      }
      if (selectedMode === "av_vad") {
        if (!NativeRecorder) {
          setError("当前 APK 缺少麦克风录制模块，请重新安装完整版本。");
          return;
        }
        const micOk = await requestMicPermission();
        if (!micOk) {
          Alert.alert("需要麦克风权限", "音视频互动模式需要麦克风权限；纯表情模式不需要。");
          return;
        }
      }
      setBusy(true);
      setProgress(0);
      let nativeAudioStarted = false;
      let cameraRecordingStarted = false;
      let localVideoPath: string | null = null;
      let trimmedVideoPath: string | null = null;
      let localWavPath: string | null = null;
      let localMergedPath: string | null = null;
      let retainFiles = false;
      let phase = "录制";
      try {
        const countdown = Math.min(10, Math.max(0, Math.floor(Number(settings.preDelay) || 0)));
        for (let left = countdown; left > 0; left--) {
          setStatus(`请就位，${left} 秒后开始录制…`);
          await sleep(1000);
        }
        if (!cameraRef.current || !cameraReady) throw new Error("摄像头尚未准备好，请稍候重试。");

        setRecording(true);
        const startedAt = Date.now();
        setStatus(selectedMode === "face_only" ? "纯表情录制中…" : "正在侦听语音…");
        if (selectedMode === "av_vad") {
          await NativeRecorder!.startCapture();
          nativeAudioStarted = true;
        }
        // VAD 停顿结束后直接裁掉等待部分，不再要求环境底噪接近零。
        let trimTailMs = 0;
        const silenceTimeout = Math.max(0.5, Number(settings.vadSilence) || 1.5);
        const keepTailMs = Math.min(1, silenceTimeout * 0.25) * 1000;
        const maxDuration = selectedMode === "face_only" ? 6 : 61;
        const videoPromise = cameraRef.current.recordAsync({ maxDuration });
        cameraRecordingStarted = true;

        if (selectedMode === "face_only") {
          for (let second = 0; second < 5; second++) {
            await sleep(1000);
            setProgress(Math.min(80, Math.round(((second + 1) / 5) * 80)));
            setStatus(`纯表情录制中 · ${second + 1}/5 秒`);
          }
        } else {
          const threshold = Math.max(1, Number(settings.vadThreshold) || 200);
          let hasSpoken = false;
          let lastVoiceAt = startedAt;
          const recent: number[] = [];
          while (Date.now() - startedAt < 60_000) {
            await sleep(120);
            const rawRms = await NativeRecorder!.getRms().catch(() => 0);
            recent.push(rawRms);
            if (recent.length > 5) recent.shift();
            const rms = recent.reduce((sum, value) => sum + value, 0) / Math.max(1, recent.length);
            const elapsed = (Date.now() - startedAt) / 1000;
            if (rms > threshold) {
              hasSpoken = true;
              lastVoiceAt = Date.now();
            }
            setProgress(Math.min(80, Math.round((elapsed / 60) * 80)));
            if (!hasSpoken) {
              setStatus(`正在侦听 · 音量 ${Math.round(rms)} / 阈值 ${Math.round(threshold)} · 5 秒内等待开口`);
              if (elapsed >= 5) break;
            } else {
              const silence = (Date.now() - lastVoiceAt) / 1000;
              setStatus(rms > threshold ? `检测到语音 · 音量 ${Math.round(rms)} / 阈值 ${Math.round(threshold)}` : `语音停顿中 · ${silence.toFixed(1)}/${silenceTimeout} 秒 · 阈值 ${Math.round(threshold)}`);
              if (silence >= silenceTimeout) {
                trimTailMs = silenceTimeout * 1000 - keepTailMs;
                break;
              }
            }
          }
        }

        setStatus("录制结束，正在封装并上传…");
        setProgress(85);
        cameraRef.current?.stopRecording();
        // 与相机同时请求停止，避免相机封装耗时被录成音频末尾空白。
        const audioStopPromise = selectedMode === "av_vad"
          ? NativeRecorder!.stopCapture(trimTailMs)
          : null;
        // 及时接住原生拒绝，最终 await 仍会报告同一个错误。
        void audioStopPromise?.catch(() => undefined);
        const videoResult = await videoPromise;
        let audioPath: string;
        let confirmedTrimMs = 0;
        if (selectedMode === "av_vad") {
          const audioResult = await audioStopPromise!;
          audioPath = audioResult.path;
          confirmedTrimMs = audioResult.trimmedTailMs;
        } else {
          audioPath = await NativeRecorder!.createSilentWav(5000);
        }
        nativeAudioStarted = false;
        cameraRecordingStarted = false;
        setRecording(false);
        if (!videoResult?.uri) throw new Error("没有生成视频文件，请检查摄像头权限和剩余存储空间。");
        localVideoPath = videoResult.uri;
        localWavPath = audioPath;
        let uploadVideoPath = videoResult.uri;
        if (confirmedTrimMs > 0) {
          trimmedVideoPath = await NativeRecorder!.trimVideoTail(videoResult.uri, confirmedTrimMs);
          uploadVideoPath = trimmedVideoPath;
        }
        setStatus("正在合成音视频…");
        phase = "合成";
        const mergedPath = await NativeRecorder!.mergeMedia(uploadVideoPath, audioPath, Number(settings.audioOffset) || 0);
        localMergedPath = mergedPath;
        phase = "上传";
        const pending: PendingCapture = {
          videoUri: uploadVideoPath, wavPath: audioPath, mergedPath,
          hasAudio: selectedMode === "av_vad",
          cleanupPaths: [localVideoPath, trimmedVideoPath, localWavPath, localMergedPath].filter((path): path is string => !!path),
        };
        setPendingUpload(pending);
        retainFiles = true;
        await uploadCapture(uploadVideoPath, audioPath, mergedPath, selectedMode === "av_vad");
        retainFiles = false;
        setPendingUpload(null);
      } catch (e) {
        if (cameraRecordingStarted || nativeAudioStarted) {
          try {
            if (cameraRecordingStarted) cameraRef.current?.stopRecording();
            if (nativeAudioStarted) await NativeRecorder?.stopCapture(0);
          } catch {
            // Preserve the first failure for the operator.
          }
        }
        setRecording(false);
        setError(`${phase}失败：${messageOf(e)}`);
        setStatus(retainFiles ? "录制成功，上传失败；文件已保留，可重试上传" : `${phase}失败，请查看错误详情后重试`);
      } finally {
        for (const path of [localVideoPath, trimmedVideoPath, localWavPath, localMergedPath]) {
          if (path && !retainFiles) void NativeRecorder?.deleteFile(path).catch(() => undefined);
        }
        setBusy(false);
      }
    },
    [busy, recording, pendingUpload, cameraReady, ensureCameraPermission, requestMicPermission, settings, uploadCapture],
  );

  const submitEmotion = useCallback(
    async (emotion: string | null, isInvalid: boolean, skip = false) => {
      if (!uploadedId) return;
      setBusy(true);
      setError("");
      try {
        if (!skip) {
          const result = await api(`/api/upload_sample/${encodeURIComponent(uploadedId)}/emotion`, {
            method: "POST",
            body: JSON.stringify({ emotion, is_invalid: isInvalid }),
          });
          if (!result?.ok) throw new Error(result?.msg || "情绪标注未成功");
        }
        setStatus(skip ? `已跳过标注 · ${uploadedId}` : isInvalid ? `已标记无效 · ${uploadedId}` : `标注完成 · ${uploadedId}，可以继续录制`);
        setUploadedId(null);
        setProgress(0);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [api, uploadedId],
  );

  const loadSamples = useCallback(async () => {
    setLoadingSamples(true);
    setError("");
    try {
      const data = await api("/api/samples");
      if (!Array.isArray(data)) throw new Error("服务器返回的样本列表格式不正确");
      let result = data as Sample[];
      if (reviewFilter === "pending") {
        result = result.filter((sample) => !sample.is_reviewed && !sample.is_invalid);
        result = result.sort(() => Math.random() - 0.5);
      } else {
        result = result.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      }
      setSamples(result);
    } catch (e) {
      setError(`加载复核样本失败：${messageOf(e)}`);
    } finally {
      setLoadingSamples(false);
    }
  }, [api, reviewFilter]);

  useEffect(() => {
    if (tab === "review" && ready) void loadSamples();
  }, [tab, reviewFilter, ready, loadSamples]);

  const openReview = useCallback(
    async (sample: Sample) => {
      setError("");
      try {
        await api(`/api/samples/${encodeURIComponent(sample.id)}/lock`, {
          method: "POST",
          body: JSON.stringify({ board_id: settings.boardId }),
        });
        setReviewVideoFallback(false);
        setSelectedSample(sample);
      } catch (e) {
        Alert.alert("无法打开样本", `样本可能正由其他设备复核，或服务器不可达。\n${messageOf(e)}`);
      }
    },
    [api, settings.boardId],
  );

  const closeReview = useCallback(async () => {
    const sample = selectedSample;
    setSelectedSample(null);
    if (!sample) return;
    try {
      await api(`/api/samples/${encodeURIComponent(sample.id)}/unlock`, {
        method: "POST",
        body: JSON.stringify({ board_id: settings.boardId }),
      });
    } catch {
      // The server lock expires automatically; closing should remain available offline.
    }
  }, [api, selectedSample, settings.boardId]);

  const submitReview = useCallback(
    async (emotion: string | null, isInvalid: boolean) => {
      if (!selectedSample) return;
      setBusy(true);
      try {
        const result = await api(`/api/samples/${encodeURIComponent(selectedSample.id)}/review`, {
          method: "POST",
          body: JSON.stringify({ review_emotion: emotion, is_invalid: isInvalid, board_id: settings.boardId }),
        });
        setSelectedSample(null);
        setStatus(isInvalid ? `已将 ${selectedSample.id} 标记为无效` : `复核完成 · ${selectedSample.id}（第 ${result.review_count} 次）`);
        await loadSamples();
      } catch (e) {
        Alert.alert("提交复核失败", messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [api, loadSamples, selectedSample, settings.boardId],
  );

  const reindexSamples = useCallback(() => {
    Alert.alert(
      "确认重排样本编号？",
      "此操作会将无效或标注冲突样本移入服务器备份目录，并重编号其余样本。该操作会修改远端数据，且编号变化后旧链接可能失效。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "确认重排",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              const result = await api("/api/samples/reindex", { method: "POST" });
              Alert.alert("重排完成", result.msg || `剩余 ${result.count ?? 0} 条，移出 ${result.deleted ?? 0} 条`);
              await loadSamples();
            } catch (e) {
              Alert.alert("重排失败", messageOf(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [api, loadSamples]);

  const audioCount = samples.filter((sample) => sample.has_audio).length;
  const silentCount = samples.length - audioCount;

  if (!ready) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator color="#41d9ed" />
        <Text style={styles.muted}>正在读取本机设置…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={[styles.header, landscape && styles.headerLandscape]}>
        <View style={{ flex: 1, marginRight: 10 }}>
          <Text style={[styles.title, landscape && styles.titleLandscape]} numberOfLines={1}>🎭 多模态情感采集</Text>
          {!landscape && <Text style={styles.subtitle} numberOfLines={1}>{settings.boardId} · {settings.server}</Text>}
        </View>
        <Pressable style={styles.settingsButton} onPress={() => setSettingsOpen(true)}>
          <Text style={styles.settingsButtonText}>设置</Text>
        </Pressable>
      </View>

      <View style={[styles.tabs, landscape && styles.tabsLandscape]}>
        <Pressable onPress={() => setTab("collect")} style={[styles.tab, landscape && styles.tabLandscape, tab === "collect" && styles.activeTab]}>
          <Text style={[styles.tabText, tab === "collect" && styles.activeTabText]}>📹 采集录制</Text>
        </Pressable>
        <Pressable onPress={() => setTab("review")} style={[styles.tab, landscape && styles.tabLandscape, tab === "review" && styles.activeTab]}>
          <Text style={[styles.tabText, tab === "review" && styles.activeTabText]}>🔍 盲审复核</Text>
        </Pressable>
      </View>

      {tab === "collect" ? (
        <View style={{ flex: 1 }} onLayout={({ nativeEvent: { layout } }) => {
          setCaptureViewport((old) => old.width === layout.width && old.height === layout.height
            ? old : { width: layout.width, height: layout.height });
        }}>
        <ScrollView contentContainerStyle={[styles.content, landscape && styles.collectLandscape]} keyboardShouldPersistTaps="handled">
          <View style={[styles.cameraFrame, previewSize, landscape && styles.cameraFrameLandscape]}>
            {cameraPermission?.granted ? (
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing="front"
                mode="video"
                videoQuality="480p"
                ratio="16:9"
                mirror
                mute
                onCameraReady={() => setCameraReady(true)}
                onMountError={(event) => setError(event.message || "摄像头启动失败")}
              />
            ) : (
              <Pressable style={styles.permissionPrompt} onPress={() => void ensureCameraPermission()}>
                <Text style={styles.cameraPlaceholder}>📷</Text>
                <Text style={styles.muted}>点击授权并开启手机摄像头预览</Text>
              </Pressable>
            )}
            {recording && <View style={styles.recBadge}><Text style={styles.recBadgeText}>● REC {mode === "face_only" ? "纯表情" : "音视频"}</Text></View>}
            {recording && <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]} /></View>}
          </View>

          <ControlsContainer style={[styles.collectControls, landscape && styles.collectControlsLandscape,
            landscape && { height: Math.max(0, viewportHeight - 28) }]}
            {...(landscape ? { keyboardShouldPersistTaps: "handled" as const, nestedScrollEnabled: true } : {})}>
          <View style={[styles.statusBox, landscape && styles.statusBoxLandscape]}>
            {busy && <ActivityIndicator color="#44d9ec" style={styles.inlineSpinner} />}
            <Text style={styles.statusText}>{status}</Text>
            {!!error && <Text style={styles.errorText}>{error}</Text>}
          </View>

          {pendingUpload ? (
            <View style={styles.panel}>
              <Text style={styles.sectionTitle}>录制已保留，等待上传</Text>
              <Text style={styles.hint}>可直接重试上传这次录制，无需重新录制。文件会保留到上传成功或主动丢弃，请保持应用打开。</Text>
              <View style={styles.row}>
                <AppButton title={busy ? "正在上传…" : "重试上传"} disabled={busy} onPress={() => void retryUpload()} />
                <AppButton title="丢弃并重新录制" color="#913b45" disabled={busy} onPress={discardPendingUpload} />
              </View>
            </View>
          ) : uploadedId ? (
            <View style={styles.panel}>
              <Text style={styles.sectionTitle}>请选择本次录制的情绪</Text>
              <View style={styles.emotionGrid}>
                {EMOTIONS.map((emotion) => (
                  <AppButton key={emotion.key} title={emotion.label} disabled={busy} onPress={() => void submitEmotion(emotion.key, false)} />
                ))}
              </View>
              <View style={styles.row}>
                <AppButton title="⛔ 标记无效" color="#913b45" disabled={busy} onPress={() => void submitEmotion(null, true)} />
                <AppButton title="跳过，稍后复核" color="#48566b" disabled={busy} onPress={() => void submitEmotion(null, false, true)} />
              </View>
            </View>
          ) : (
            <>
              <View style={styles.panel}>
                <Text style={styles.sectionTitle}>录制模式</Text>
                <View style={styles.row}>
                  <AppButton
                    title={"😐 纯表情\n固定 5 秒 · 不录音"}
                    color="#1264c4"
                    disabled={busy || !cameraReady}
                    onPress={() => void startCapture("face_only")}
                  />
                  <AppButton
                    title={"🎙️ 音视频互动\nVAD 检测说话和停顿"}
                    color="#5a46b6"
                    disabled={busy || !cameraReady}
                    onPress={() => void startCapture("av_vad")}
                  />
                </View>
                <Text style={styles.hint}>录制将使用本机前置摄像头；语音模式在 5 秒内等待开口，说完停顿后自动结束，最长 60 秒。</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryText}>准备倒计时：{settings.preDelay}s</Text>
                <Text style={styles.summaryText}>静音阈值：{settings.vadSilence}s</Text>
                <Text style={styles.summaryText}>音量阈值：{settings.vadThreshold}</Text>
                <Text style={styles.summaryText}>音频补偿：{settings.audioOffset}s</Text>
              </View>
            </>
          )}
          </ControlsContainer>
        </ScrollView>
        </View>
      ) : (
        <View style={styles.reviewContainer}>
          <View style={styles.reviewToolbar}>
            <Pressable style={styles.filterButton} onPress={() => setReviewFilter((old) => old === "pending" ? "all" : "pending")}>
              <Text style={styles.filterText}>{reviewFilter === "pending" ? "⏳ 待复核" : "📁 全部样本"}　⌄</Text>
            </Pressable>
            <AppButton title="刷新" small disabled={loadingSamples || busy} onPress={() => void loadSamples()} />
            <AppButton title="重排" small color="#876018" disabled={busy} onPress={reindexSamples} />
          </View>
          <Text style={styles.hint}>盲审会隐藏原标注；同一条样本需要独立复核两次。当前 {samples.length} 条（有声 {audioCount} / 纯表情 {silentCount}）</Text>
          {loadingSamples ? (
            <ActivityIndicator color="#41d9ed" style={{ marginTop: 30 }} />
          ) : (
            <FlatList
              data={samples}
              keyExtractor={(sample) => sample.id}
              contentContainerStyle={styles.sampleList}
              ListEmptyComponent={<Text style={styles.emptyText}>暂无样本，或列表加载失败。下拉刷新后重试。</Text>}
              renderItem={({ item }) => (
                <Pressable style={styles.sampleCard} onPress={() => void openReview(item)}>
                  <View style={styles.sampleMain}>
                    <Text style={styles.sampleId}>{item.id}　{item.has_audio ? "🎙️ 有声" : "😐 纯表情"}</Text>
                    <Text style={styles.sampleMeta}>{item.created_at || ""} · 设备 {item.board_id || "?"}</Text>
                  </View>
                  <Text style={[styles.sampleState, item.is_reviewed ? styles.goodText : styles.pendingText]}>
                    {item.is_invalid ? "无效" : item.is_reviewed ? "已完成" : `待复核 ${item.review_count || 0}/2`}
                  </Text>
                </Pressable>
              )}
            />
          )}
          {!!error && <Text style={styles.errorText}>{error}</Text>}
        </View>
      )}

      <Modal visible={settingsOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSettingsOpen(false)}>
        <SafeAreaView style={styles.modalSafe}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <ScrollView contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
              <View style={styles.modalHeader}>
                <Text style={styles.title}>采集设置</Text>
                <Pressable onPress={() => setSettingsOpen(false)}><Text style={styles.closeText}>关闭</Text></Pressable>
              </View>
              <Text style={styles.hint}>仅修改本机配置。服务端仍为远端原有 API，不会改动服务端程序。</Text>
              <SettingField label="服务器地址" value={settings.server} onChangeText={(value) => updateSetting("server", value)} placeholder="http://host:9004" autoCapitalize="none" />
              <SettingField label="上传令牌" value={settings.token} onChangeText={(value) => updateSetting("token", value)} secureTextEntry autoCapitalize="none" />
              <SettingField label="设备编号（复核锁用）" value={settings.boardId} onChangeText={(value) => updateSetting("boardId", value)} autoCapitalize="none" />
              <SettingField label="准备倒计时（0–10 秒）" value={settings.preDelay} onChangeText={(value) => updateSetting("preDelay", value)} keyboardType="decimal-pad" />
              <SettingField label="语音停顿结束阈值（0.5–6 秒）" value={settings.vadSilence} onChangeText={(value) => updateSetting("vadSilence", value)} keyboardType="decimal-pad" />
              <SettingField label="VAD 音量阈值（RMS，越低越灵敏）" value={settings.vadThreshold} onChangeText={(value) => updateSetting("vadThreshold", value)} keyboardType="decimal-pad" />
              <SettingField label="音视频时间补偿（-5 到 5 秒；正值音频延后）" value={settings.audioOffset} onChangeText={(value) => updateSetting("audioOffset", value)} keyboardType="decimal-pad" />
              <AppButton title={saveBusy ? "正在保存…" : "保存设置"} disabled={saveBusy} onPress={() => void saveSettings()} />
              <Text style={styles.footnote}>访问令牌单独保存在 Android 安全存储中；服务器地址与设备编号保存在本机。</Text>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      <Modal visible={!!selectedSample} animationType="slide" onRequestClose={() => void closeReview()}>
        <SafeAreaView style={styles.modalSafe}>
          {selectedSample && (
            <ScrollView contentContainerStyle={styles.reviewDetail} keyboardShouldPersistTaps="handled">
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.sectionTitle}>{selectedSample.id}</Text>
                  <Text style={styles.hint}>盲审 · 当前已提交 {selectedSample.review_count || 0}/2 次</Text>
                </View>
                <Pressable onPress={() => void closeReview()}><Text style={styles.closeText}>关闭</Text></Pressable>
              </View>
              <ReviewMediaPlayer
                key={`${selectedSample.id}-${reviewVideoFallback ? "video" : "merged"}`}
                playerRef={reviewVideoRef}
                uri={endpoint(settings.server, `/data/${encodeURIComponent(selectedSample.id)}/${reviewVideoFallback ? "video.mp4" : "merged.mp4"}`)}
                token={settings.token}
                label={reviewVideoFallback ? "原视频" : "音视频"}
                beforePlay={async () => { await reviewAudioRef.current?.pauseAsync().catch(() => undefined); }}
                onUnavailable={() => {
                  if (!reviewVideoFallback) setReviewVideoFallback(true);
                }}
              />
              {selectedSample.has_audio && (
                <ReviewMediaPlayer
                  playerRef={reviewAudioRef}
                  uri={endpoint(settings.server, `/data/${encodeURIComponent(selectedSample.id)}/audio.wav`)}
                  token={settings.token}
                  label="独立音频"
                  audioOnly
                  beforePlay={async () => { await reviewVideoRef.current?.pauseAsync().catch(() => undefined); }}
                />
              )}
              <Text style={[styles.sectionTitle, { marginTop: 18 }]}>独立判断情绪</Text>
              <View style={styles.emotionGrid}>
                {EMOTIONS.map((emotion) => (
                  <AppButton key={emotion.key} title={emotion.label} disabled={busy} onPress={() => void submitReview(emotion.key, false)} />
                ))}
              </View>
              <AppButton title="⛔ 判定为无效样本" color="#913b45" disabled={busy} onPress={() => void submitReview(null, true)} />
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function SettingField({
  label,
  value,
  onChangeText,
  secureTextEntry = false,
  keyboardType = "default",
  placeholder,
  autoCapitalize = "none",
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "decimal-pad";
  placeholder?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor="#72839a"
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#071a30" },
  loadingScreen: { flex: 1, backgroundColor: "#071a30", alignItems: "center", justifyContent: "center", gap: 12 },
  header: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLandscape: { paddingTop: 3, paddingBottom: 4 },
  titleLandscape: { fontSize: 17 },
  tabsLandscape: { marginBottom: 4 },
  tabLandscape: { paddingVertical: 7 },
  title: { color: "#eaf7ff", fontSize: 21, fontWeight: "800" },
  subtitle: { color: "#7ca5c6", fontSize: 11, marginTop: 4 },
  settingsButton: { borderColor: "#0b9fbe", borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 8 },
  settingsButtonText: { color: "#53dcec", fontWeight: "700" },
  tabs: { flexDirection: "row", marginHorizontal: 14, marginBottom: 10, borderRadius: 12, backgroundColor: "#102844", overflow: "hidden" },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center" },
  activeTab: { backgroundColor: "#12395d", borderBottomColor: "#21d1e7", borderBottomWidth: 2 },
  tabText: { color: "#83a2bf", fontWeight: "700" },
  activeTabText: { color: "#5be5f2" },
  content: { padding: 14, paddingBottom: 30 },
  collectLandscape: { flexDirection: "row", alignItems: "flex-start", gap: 16, paddingBottom: 14 },
  collectControls: { width: "100%" },
  collectControlsLandscape: { flex: 1, width: undefined, minWidth: 0 },
  cameraFrame: { alignSelf: "center", backgroundColor: "#02070d", borderRadius: 18, overflow: "hidden", borderColor: "#164c75", borderWidth: 1 },
  cameraFrameLandscape: { alignSelf: "flex-start" },
  statusBoxLandscape: { marginTop: 0, minHeight: 40, padding: 8 },
  permissionPrompt: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
  cameraPlaceholder: { fontSize: 42 },
  recBadge: { position: "absolute", top: 12, right: 12, backgroundColor: "#c52e42", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  recBadgeText: { color: "white", fontWeight: "800", fontSize: 12 },
  progressTrack: { position: "absolute", bottom: 0, left: 0, right: 0, height: 5, backgroundColor: "#53647a" },
  progressFill: { height: "100%", backgroundColor: "#f04552" },
  statusBox: { minHeight: 53, marginTop: 12, marginBottom: 12, borderRadius: 12, backgroundColor: "#10243b", borderColor: "#1e3a56", borderWidth: 1, padding: 11, justifyContent: "center" },
  statusText: { color: "#c4e2f7", textAlign: "center", fontSize: 13 },
  inlineSpinner: { marginBottom: 5 },
  errorText: { color: "#ff9ba5", textAlign: "center", fontSize: 12, marginTop: 7 },
  panel: { backgroundColor: "#0e2742", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#1c4263", marginBottom: 11 },
  sectionTitle: { color: "#e2f5ff", fontSize: 16, fontWeight: "800", marginBottom: 11 },
  row: { flexDirection: "row", gap: 9, marginBottom: 8 },
  button: { flex: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 13, alignItems: "center", justifyContent: "center", minHeight: 48 },
  smallButton: { flex: 0, minHeight: 38, paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { color: "white", fontWeight: "700", textAlign: "center", fontSize: 13 },
  hint: { color: "#86a4bd", fontSize: 11, lineHeight: 17, marginTop: 4 },
  emotionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 9 },
  summaryRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 7, paddingHorizontal: 4 },
  summaryText: { color: "#8bb0ce", fontSize: 11 },
  muted: { color: "#8aa9c4", fontSize: 13 },
  reviewContainer: { flex: 1, paddingHorizontal: 14, paddingBottom: 10 },
  reviewToolbar: { flexDirection: "row", gap: 7, alignItems: "center" },
  filterButton: { flex: 1, height: 38, justifyContent: "center", paddingHorizontal: 11, borderRadius: 10, backgroundColor: "#102844", borderWidth: 1, borderColor: "#1e3b59" },
  filterText: { color: "#d5e9f8", fontSize: 13 },
  sampleList: { paddingTop: 10, paddingBottom: 30, gap: 8 },
  sampleCard: { backgroundColor: "#102843", borderRadius: 13, padding: 13, borderColor: "#204361", borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  sampleMain: { flex: 1 },
  sampleId: { color: "#e0f3ff", fontWeight: "700", fontSize: 13 },
  sampleMeta: { color: "#819db5", fontSize: 10, marginTop: 5 },
  sampleState: { fontSize: 11, fontWeight: "700" },
  pendingText: { color: "#f1c861" },
  goodText: { color: "#62d39c" },
  emptyText: { color: "#859fb5", textAlign: "center", paddingTop: 45, fontSize: 13 },
  modalSafe: { flex: 1, backgroundColor: "#071a30" },
  settingsContent: { padding: 18, paddingBottom: 32 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  closeText: { color: "#5ce0ed", fontSize: 14, fontWeight: "700", padding: 8 },
  fieldWrap: { marginTop: 16 },
  fieldLabel: { color: "#b5d2e9", fontSize: 12, fontWeight: "700", marginBottom: 6 },
  input: { backgroundColor: "#102843", color: "#f0f8ff", borderWidth: 1, borderColor: "#2b4d6b", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  footnote: { color: "#718da7", fontSize: 11, lineHeight: 17, marginTop: 15 },
  reviewDetail: { padding: 16, paddingBottom: 35 },
  reviewVideo: { width: "100%", height: 300, backgroundColor: "#02070d", borderRadius: 14, marginTop: 7 },
  reviewAudio: { width: "100%", height: 58, marginTop: 10, backgroundColor: "#0e2742" },
});
