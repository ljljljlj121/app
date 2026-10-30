from __future__ import annotations
from collections import deque
from dataclasses import dataclass
import math
import wave

@dataclass
class Segment:
    kind: str
    start: float
    pcm: bytes

class Segmenter:
    """Pure sample-driven state machine; accepts one 20 ms PCM frame per feed."""
    def __init__(self, idle=3.0, end_silence=0.6, pre_roll=0.3, max_speech=15.0,
                 onset_seconds=.2, onset_ratio=.8):
        self.idle_frames = math.ceil(idle / .02)
        self.end_frames = math.ceil(end_silence / .02)
        self.pre_frames = math.ceil(pre_roll / .02)
        self.max_frames = math.ceil(max_speech / .02)
        self.pending = []
        self.speaking = False
        self.quiet = 0
        self.start = 0.0
        self.onset = deque(maxlen=max(1, math.ceil(onset_seconds / .02)))
        self.onset_ratio = onset_ratio

    def feed(self, pcm, voiced, timestamp):
        if not self.pending:
            self.start = timestamp
        self.onset.append(bool(voiced))
        confirmed = (voiced and len(self.onset) == self.onset.maxlen
                     and sum(self.onset) >= math.ceil(self.onset.maxlen * self.onset_ratio))
        if confirmed and not self.speaking:
            # Discard incomplete idle interval; retain audio immediately before onset.
            onset_length = len(self.onset) - next(i for i, value in enumerate(self.onset) if value)
            keep = min(len(self.pending), self.pre_frames + onset_length - 1)
            self.pending = self.pending[-keep:] if keep else []
            self.start = timestamp - keep * .02
            self.speaking = True
        self.pending.append(pcm)
        self.quiet = 0 if voiced else self.quiet + 1
        if self.speaking:
            if self.quiet >= self.end_frames:
                return self.flush('speech')
            if len(self.pending) >= self.max_frames:
                # Keep speech mode across forced cuts, so the continuation is not lost.
                return self.flush('speech_limit', continuing=True)
        elif (len(self.pending) >= self.idle_frames and
              (not any(self.onset) or len(self.pending) >= self.idle_frames + self.onset.maxlen)):
            return self.flush('idle')
        return None

    def flush(self, kind='shutdown', continuing=False):
        if not self.pending:
            return None
        result = Segment(kind, self.start, b''.join(self.pending))
        self.pending = []
        self.speaking = continuing
        self.quiet = 0
        self.onset.clear()
        return result

class VoiceGate:
    """Energy gate plus explicit quiet-room calibration; never learns from speech."""
    def __init__(self, threshold=-45.0, margin=10.0):
        self.threshold = threshold
        self.margin = margin
        self.samples = []
        self.remaining = 75  # 1.5 seconds at 20 ms/frame
        self.noise = None

    def recalibrate(self):
        self.samples = []
        self.remaining = 75

    def feed(self, db, vad_voiced):
        if self.remaining:
            self.samples.append(db)
            self.remaining -= 1
            if not self.remaining:
                self.noise = sorted(self.samples)[int((len(self.samples) - 1) * .9)]
                self.threshold = min(-10, max(-55, self.noise + self.margin))
            return False
        return bool(vad_voiced and db >= self.threshold)

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
