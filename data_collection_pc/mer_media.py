import math
import wave

def save_media(cv2, np, segment, frames, folder, fps):
    if not frames:
        raise RuntimeError('No camera frames available for this interval')
    audio = folder / 'audio.wav'
    video = folder / 'video.mp4'
    with wave.open(str(audio), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(segment.pcm)
    first = cv2.imdecode(np.frombuffer(frames[0][1], dtype=np.uint8), cv2.IMREAD_COLOR)
    height, width = first.shape[:2]
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*'mp4v'), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError('Cannot create MP4 with mp4v codec')
    try:
        index = 0
        # Resample timestamped camera frames onto the same timeline as the WAV.
        count = max(1, math.ceil(len(segment.pcm) / 32000 * fps))
        for i in range(count):
            target = segment.start + i / fps
            while index + 1 < len(frames) and frames[index + 1][0] <= target:
                index += 1
            frame = cv2.imdecode(np.frombuffer(frames[index][1], dtype=np.uint8), cv2.IMREAD_COLOR)
            writer.write(cv2.resize(frame, (width, height)))
    finally:
        writer.release()
    return video, audio
