export type CaptureFiles = {
  videoUri: string;
  wavPath: string;
  mergedPath: string;
  hasAudio: boolean;
};

export function uploadFileUri(path: string): string {
  if (path.startsWith("file://") || path.startsWith("content://")) return path;
  if (path.startsWith("/")) return `file://${path}`;
  throw new Error("上传文件路径无效，请重新录制");
}

export function captureFormData(files: CaptureFiles, boardId: string): FormData {
  const form = new FormData();
  form.append("board_id", boardId.trim());
  form.append("has_audio", files.hasAudio ? "true" : "false");
  for (const [field, path, name, type] of [
    ["video", files.videoUri, "video.mp4", "video/mp4"],
    ["audio", files.wavPath, "audio.wav", "audio/wav"],
    ["merged", files.mergedPath, "merged.mp4", "video/mp4"],
  ]) {
    form.append(field, { uri: uploadFileUri(path), name, type } as any);
  }
  return form;
}
