import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View, Pressable } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export type SpeechConfig = { base: string; key: string; model: string; rms: number; silenceMs: number; textWeight: number };
export const defaultSpeechConfig: SpeechConfig = {
  base: "http://183.62.69.210:9005/v1", key: "", model: "/data2/lzh/emo/checkpoint",
  rms: 200, silenceMs: 1000, textWeight: .75,
};
export type SpeechRecord = {
  id: string; localStatus: string; cloudStatus: string; endReason?: string;
  startedAtMs: number; endedAtMs?: number; durationMs?: number;
  transcript: string; liveTranscript?: string; textTag?: string; fusionTag?: string; fusionMode?: string;
  visualStatus?: string; visualStates?: Record<string, number>; chunks?: number;
  asrMs?: number; localMs?: number; cloudMs?: number; completedAt?: number;
  cloudTag?: string; error?: string; localError?: string; cloudError?: string;
};
export type SpeechBatch = { sessionId: string; state: string; recordingId: string | null; rms: number; rmsThreshold: number; error?: string; records: SpeechRecord[] };
const states: Record<string, string> = {
  listening: "本机监听中", recording: "录制中", waiting_silence: "达到时长上限，等待恢复静音",
  queue_full_waiting_silence: "处理队列已满，本句未录制；等待静音后恢复",
  waiting_for_video: "等待摄像头画面", microphone_permission_required: "需要麦克风权限",
  microphone_error: "麦克风异常", stopped: "已停止", finalizing: "封装中", queued: "排队中",
  microphone_starting: "麦克风正在启动",
  asr: "离线转写中", text: "本机文本分类中", processing: "云端处理中", completed: "完成",
  failed: "失败", cancelled: "已取消", queue_full: "队列已满", media_failed: "媒体封装失败",
  user_cancelled: "用户暂停", background: "后台已停止", camera_interrupted: "相机中断",
};
const modes: Record<string, string> = { A2_F3: "图文融合", visual_only: "仅视觉", text_only: "仅文本", unavailable: "无有效结果" };
const endings: Record<string, string> = {
  natural_end: "静音结束", duration_limit: "15 秒上限", user_cancelled: "用户取消",
  background: "进入后台取消", switching: "切镜头取消", page_left: "离开页面取消",
  capture_interrupted: "采集中断", backlog_rejected: "队列积压，未录制",
};
const label = (value: string) => states[value] ?? value;

export function SpeechResults({ batch }: { batch: SpeechBatch | null }) {
  return <View style={s.section}>
    <Text style={s.title}>语句与云端记录</Text>
    <Text style={s.text}>{label(batch?.state ?? "stopped")} · 当前 RMS {Math.round(batch?.rms ?? 0)} / 门槛 {Math.round(batch?.rmsThreshold ?? 200)}</Text>
    {!!batch?.error && <Text style={s.error}>{batch.error}</Text>}
    {!batch?.records.length && <Text style={s.muted}>讲话后显示记录；静音时不请求云端。云端慢响应期间继续本机监听。</Text>}
    {[...(batch?.records ?? [])].reverse().map(record => <View style={s.card} key={record.id}>
      <Text style={s.text}>#{record.id} · {record.durationMs != null ? `${(record.durationMs / 1000).toFixed(2)} 秒 · ` : ""}
        {record.endReason ? endings[record.endReason] ?? record.endReason : "录制中"}</Text>
      <Text style={s.text}>云端：{record.cloudTag ?? label(record.cloudStatus)}
        {record.cloudMs != null ? ` · ${(record.cloudMs / 1000).toFixed(1)} 秒` : ""}
        {record.completedAt ? ` · ${new Date(record.completedAt).toLocaleTimeString()}` : ""}</Text>
      <Text selectable style={s.transcript}>{record.transcript || record.liveTranscript || (record.localStatus === "completed" ? "转写为空" : "等待离线 ASR…")}</Text>
      {!!record.liveTranscript && !record.transcript && <Text style={s.muted}>实时 ASR（片段结束后会用完整音频重新转写）</Text>}
      <Text style={s.text}>本机：{label(record.localStatus)}
        {record.textTag ? ` · 文本 ${record.textTag}` : ""}
        {record.fusionMode ? ` · ${modes[record.fusionMode] ?? record.fusionMode} ${record.fusionTag ?? "—"}` : ""}</Text>
      {(record.asrMs != null || record.chunks != null) && <Text style={s.muted}>
        转写 {((record.asrMs ?? 0) / 1000).toFixed(2)} 秒 · 文本 {record.chunks ?? 0} 块
        {record.localMs != null ? ` · 本机合计 ${(record.localMs / 1000).toFixed(2)} 秒` : ""}
      </Text>}
      {record.visualStates && <Text style={s.muted}>
        视觉证据 {Object.entries(record.visualStates).map(([state, count]) => `${state}: ${count}`).join(" / ")}
      </Text>}
      {[record.error, record.localError, record.cloudError].filter(Boolean).map((error, i) => <Text key={i} style={s.error}>{error}</Text>)}
    </View>)}
    <Text style={s.muted}>最近 20 条 · 视觉证据按片段时间汇总；未进行说话人与人脸身份匹配。</Text>
  </View>;
}

export async function loadSpeechConfig(): Promise<SpeechConfig> {
  const saved = await AsyncStorage.getItem("unified-emotion-config-v2");
  const key = await SecureStore.getItemAsync("unified-emotion-key-v1");
  return { ...defaultSpeechConfig, ...(saved ? JSON.parse(saved) : {}), key: key ?? "" };
}

export function SpeechSettings({ value, onSave, paused }: { value: SpeechConfig; onSave: (config: SpeechConfig) => void; paused: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  useEffect(() => setDraft(value), [value]);
  return <View style={s.section}>
    <Pressable onPress={() => setOpen(!open)}><Text style={s.link}>{open ? "收起" : "连接与分段设置"}{!paused ? "（暂停后可修改）" : ""}</Text></Pressable>
    {open && <>
      {(["base", "key", "model", "rms", "silenceMs", "textWeight"] as const).map(field => <View key={field}>
        <Text style={s.muted}>{{ base: "云端 API 地址", key: "API Key（安全保存）", model: "云端模型",
          rms: "本机 VAD 音量门槛 RMS（默认 200）", silenceMs: "连续静音毫秒（500–3000）", textWeight: "F3 文本权重（0–1）" }[field]}</Text>
        <TextInput style={s.input} value={String(draft[field])} editable={paused} secureTextEntry={field === "key"}
          autoCapitalize="none" keyboardType={["rms", "silenceMs", "textWeight"].includes(field) ? "decimal-pad" : "default"}
          onChangeText={text => setDraft(old => ({ ...old, [field]: ["rms", "silenceMs", "textWeight"].includes(field) ? Number(text) : text }))} />
      </View>)}
      {!!error && <Text style={s.error}>{error}</Text>}
      <Pressable disabled={!paused} onPress={() => {
        if (!/^https?:\/\/\S+$/.test(draft.base) || !draft.model.trim() ||
          !Number.isFinite(draft.rms) || draft.rms < 50 || draft.rms > 10000 ||
          !Number.isFinite(draft.silenceMs) || draft.silenceMs < 500 || draft.silenceMs > 3000 ||
          !Number.isFinite(draft.textWeight) || draft.textWeight < 0 || draft.textWeight > 1) {
          setError("请检查地址、模型和数值范围"); return;
        }
        void (async () => {
          try {
            const { key, ...publicConfig } = draft;
            await SecureStore.setItemAsync("unified-emotion-key-v1", key);
            await AsyncStorage.setItem("unified-emotion-config-v2", JSON.stringify(publicConfig));
            onSave(draft); setError(""); setOpen(false);
          } catch { setError("设置保存失败，请重试"); }
        })();
      }}><Text style={s.link}>保存设置</Text></Pressable>
    </>}
  </View>;
}
const s = StyleSheet.create({
  section: { gap: 7, marginTop: 12 }, title: { color: "#f2f7ff", fontWeight: "700", fontSize: 16 },
  card: { padding: 10, borderRadius: 10, backgroundColor: "#102844", gap: 5 },
  text: { color: "#e6f0ff", fontSize: 12 }, muted: { color: "#9ab2ce", fontSize: 11 },
  transcript: { color: "#dcefff", fontSize: 13, lineHeight: 19 }, error: { color: "#ff9aa4", fontSize: 12 },
  link: { color: "#41d9ed", paddingVertical: 8 }, input: { backgroundColor: "#102844", color: "#e6f0ff", padding: 9, borderRadius: 8 },
});
