export type EmotionTag = "positive" | "negative" | "neutral";
export type EmotionFrame = {
  sessionId: string;
  frameId: number;
  capturedAtMs: number | null;
  sensorTimestampNs: string;
  analysisStartedAtMs: number;
  timestampMs: number;
  completedAtMs: number;
  status: string;
  tag: EmotionTag | null;
  probabilities: number[] | null;
  confidence: number | null;
  faceBox: number[] | null;
  processingMs: number;
  captureToResultMs: number | null;
  timestampSource: string;
  error?: string;
  errorStage?: string;
};

export type EmotionBatch = {
  sessionId: string;
  records: EmotionFrame[];
  nowMs: number;
  state: string;
  detail: string | null;
  current: EmotionFrame | null;
  historyCount: number;
  analyzedFrames: number;
  analysisFps: number;
  cameraFramesObserved: number;
  backpressureDroppedEstimate: number;
  captureLatencyP95Ms: number | null;
  timestampSource: string;
};

export const TAG_LABELS: Record<EmotionTag, string> = {
  positive: "正向", negative: "负向", neutral: "中性",
};
export const STATUS_LABELS: Record<string, string> = {
  initializing: "正在加载本地模型", waiting: "等待分析帧", valid: "单人脸 · 识别中",
  no_face: "未检测到人脸", multiple_faces: "检测到多张人脸，请仅保留一人",
  invalid_crop: "人脸裁剪无效", inference_failed: "本帧推理失败",
  model_error: "模型加载失败", camera_error: "摄像头错误",
  camera_recovering: "相机暂不可用，正在恢复",
  permission_denied: "尚未授权摄像头", paused: "已暂停 · 窗口已冻结",
  background: "已进入后台", switching: "正在切换镜头", closed: "已关闭",
};

export function appendFrames(history: EmotionFrame[], batch: EmotionBatch): EmotionFrame[] {
  const sameSession = history.filter((frame) => frame.sessionId === batch.sessionId);
  const lastId = sameSession[sameSession.length - 1]?.frameId ?? 0;
  return [...sameSession, ...batch.records.filter((frame) =>
    frame.sessionId === batch.sessionId && frame.frameId > lastId)]
    .filter((frame) => batch.nowMs - frame.timestampMs <= 30_000)
    .slice(-900);
}

export function visibleFrames(history: EmotionFrame[], nowMs: number, windowMs = 3000) {
  return history.filter((frame) => nowMs - frame.timestampMs <= windowMs);
}
