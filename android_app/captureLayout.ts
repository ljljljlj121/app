export function getCapturePreviewSize(width: number, height: number, landscape: boolean) {
  const availableWidth = Math.max(0, width - 28);
  const availableHeight = Math.max(0, height - 28);
  const ratio = landscape ? 16 / 9 : 9 / 16;
  const heightLimit = landscape
    ? Math.min(190, availableHeight)
    : Math.min(300, availableHeight * 0.45);
  const widthLimit = landscape
    ? Math.min(300, Math.max(0, width - 44) * 0.46)
    : Math.min(250, availableWidth * 0.72);
  const previewWidth = Math.min(widthLimit, heightLimit * ratio);
  return { width: previewWidth, height: previewWidth / ratio };
}
