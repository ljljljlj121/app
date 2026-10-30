"""Sequential speech -> cloud inference -> listening, over existing camera/ROS inputs."""
from dataclasses import dataclass
import math
import struct
import queue
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from mer_media import save_media
from mer_inference import run_inference


@dataclass
class SpeechSegment:
    start: float
    pcm: bytes
    kind: str


class SpeechSegmenter:
    """20ms frames, indefinite idle, 600ms pause, at most 15s per utterance."""
    def __init__(self):
        self.frames = []
        self.start = 0.0
        self.quiet = 0

    def feed(self, pcm, voiced, stamp):
        if not self.frames:
            if not voiced:
                return None
            self.start = stamp
        self.frames.append(pcm)
        self.quiet = 0 if voiced else self.quiet + 1
        kind = 'speech' if self.quiet >= 30 else 'speech_limit' if len(self.frames) >= 750 else None
        if kind is None:
            return None
        segment = SpeechSegment(self.start, b''.join(self.frames), kind)
        self.frames = []
        self.quiet = 0
        return segment


class EmotionService:
    def __init__(self, camera, audio, config):
        self.camera, self.audio, self.config = camera, audio, config
        self.stop_event = threading.Event()
        self.input_lock = threading.Lock()
        self.accepting = False
        self.inputs = queue.Queue(maxsize=250)
        self.lock = threading.Lock()
        self.state = dict(running=False, phase='stopped', message='已停止', error='', result=None)
        self.thread = threading.Thread(target=self.run, daemon=True)

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def snapshot(self):
        with self.lock:
            return dict(self.state, stopping=self.stop_event.is_set() and self.thread.is_alive())

    def start(self):
        import openai  # Fail fast if optional dependency is missing.
        self.update(running=True, phase='listening', message='等待说话，可按停止结束')
        self.audio.mer_sink = self.feed
        self.resume()
        self.thread.start()

    def resume(self):
        with self.input_lock:
            while True:
                try:
                    self.inputs.get_nowait()
                except queue.Empty:
                    break
            self.accepting = not self.stop_event.is_set()

    def feed(self, data, stamp):
        with self.input_lock:
            if not self.accepting or self.stop_event.is_set():
                return
            try:
                self.inputs.put_nowait((data, stamp))
            except queue.Full:
                self.stop_event.set()
                self.update(running=False, error='音频溢出，请停止后重新开始')

    def stop(self):
        self.stop_event.set()
        with self.input_lock:
            self.accepting = False
        if self.audio.mer_sink == self.feed:
            self.audio.mer_sink = None
        self.update(running=False, phase='stopped', message='已停止')

    def recognize(self, segment, number):
        import cv2
        import numpy as np
        end = segment.start + len(segment.pcm) / 32000
        frames = self.camera.get_frames(segment.start - .1, end)
        if not frames or end - frames[-1][0] > 1:
            raise RuntimeError('摄像头没有及时返回画面')
        encoded, previous = [], float('-inf')
        for stamp, frame in frames:
            if stamp - previous >= .095:
                ok, jpeg = cv2.imencode('.jpg', frame)
                if not ok:
                    raise RuntimeError('视频编码失败')
                encoded.append((stamp, jpeg.tobytes()))
                previous = stamp
        with tempfile.TemporaryDirectory(prefix='pc_emotion_') as folder:
            video, audio = save_media(cv2, np, segment, encoded, Path(folder), 10)
            if self.stop_event.is_set():
                return
            result = run_inference(SimpleNamespace(video=video, audio=audio, gt=None,
                api_base=self.config['mer_api_base'], api_key=self.config['mer_api_key'],
                model=self.config['mer_model'], timeout=60, retries=0, retry_delay=1))
        if result['status'] != 'ok':
            raise RuntimeError(result['error'] or result['status'])
        if not self.stop_event.is_set():
            self.update(result=dict(prediction=result['prediction'], segment_id=number,
                duration=len(segment.pcm)/32000, segment_kind=segment.kind,
                api_latency=result['api_latency'], updated_at=time.time(),
                result_delay=time.monotonic()-end), error='')

    def run(self):
        segmenter = SpeechSegmenter()
        pending, next_stamp, number = b'', None, 0
        try:
            while not self.stop_event.is_set():
                try:
                    data, stamp = self.inputs.get(timeout=2)
                except queue.Empty:
                    raise RuntimeError('ROS 麦克风超过 2 秒没有数据；请检查音频订阅')
                if next_stamp is None:
                    next_stamp = stamp
                elif abs(stamp - (next_stamp + len(pending)/32000)) > .15:
                    raise RuntimeError('音频时间轴中断，请重新开始')
                pending += data
                while len(pending) >= 640 and not self.stop_event.is_set():
                    pcm, pending = pending[:640], pending[640:]
                    rms = math.sqrt(sum(value[0]**2 for value in struct.iter_unpack('<h', pcm)) / (len(pcm)//2))
                    segment = segmenter.feed(pcm, rms > self.config['mer_threshold'], next_stamp)
                    next_stamp += .02
                    self.update(phase='recording' if segmenter.frames else 'listening',
                        message='正在录制，停顿后上传识别' if segmenter.frames else '等待说话，可按停止结束', rms=round(rms))
                    if segment is None:
                        continue
                    with self.input_lock:
                        self.accepting = False
                    number += 1
                    self.update(phase='inference', message='正在上传识别，期间暂停监听')
                    try:
                        self.recognize(segment, number)
                    except Exception as exc:
                        if not self.stop_event.is_set():
                            self.update(error=f'本段检测失败：{exc}')
                            self.stop_event.wait(1)
                    if self.stop_event.is_set():
                        break
                    # Discard all audio arriving before/during inference; never queue utterances.
                    pending, next_stamp, segmenter = b'', None, SpeechSegmenter()
                    self.resume()
                    self.update(phase='listening', message='等待说话，可按停止结束')
                    break
        except Exception as exc:
            if not self.stop_event.is_set():
                self.update(error=str(exc))
        finally:
            self.stop()
