"""Bounded streaming inference over the collector's existing ROS/camera inputs."""
import math
import queue
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from mer_stream_core import Segmenter, VoiceGate, save_media
from mer_inference import run_inference


class MerService:
    def __init__(self, camera, audio, config):
        import webrtcvad
        import openai  # Fail at start, before claiming the feature is running.
        self.vad = webrtcvad.Vad(3)
        self.camera, self.audio, self.config = camera, audio, config
        self.stop_event = threading.Event()
        self.jobs = queue.Queue(maxsize=1)
        self.lock = threading.Lock()
        self.state = dict(running=True, message='请保持安静，校准 1.5 秒', error='',
                          result=None, dropped=0, queued=0)

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def snapshot(self):
        with self.lock:
            return dict(self.state, queued=self.jobs.qsize())

    def start(self):
        self.audio_queue = queue.Queue(maxsize=250)
        self.segmenter, self.gate = Segmenter(), VoiceGate()
        self.audio.mer_sink = self.feed
        threading.Thread(target=self.worker, daemon=True).start()
        threading.Thread(target=self.capture, daemon=True).start()

    def feed(self, data, stamp):
        if self.stop_event.is_set():
            return
        try:
            self.audio_queue.put_nowait((data, stamp))
        except queue.Full:
            self.update(error='音频队列溢出，请重新启动检测', running=False)
            self.stop_event.set()

    def stop(self):
        self.stop_event.set()
        if self.audio.mer_sink == self.feed:
            self.audio.mer_sink = None
        while True:
            try:
                self.jobs.get_nowait()
                self.jobs.task_done()
            except queue.Empty:
                break
        self.update(running=False, message='已停止')

    def capture(self):
        import numpy as np
        import cv2
        pending = b''
        next_stamp = None
        sequence = 0
        try:
            while not self.stop_event.is_set():
                try:
                    data, stamp = self.audio_queue.get(timeout=2)
                except queue.Empty:
                    raise RuntimeError('ROS 麦克风超过 2 秒没有数据')
                if next_stamp is None:
                    next_stamp = stamp
                elif abs(stamp - (next_stamp + len(pending) / 32000)) > .15:
                    raise RuntimeError('音频时间轴中断，请重新启动检测')
                pending += data
                while len(pending) >= 640:
                    pcm, pending = pending[:640], pending[640:]
                    db = 20 * math.log10(max(float(np.sqrt(np.mean(np.frombuffer(pcm, dtype='<i2').astype(float) ** 2))), .5) / 32768)
                    calibrating = self.gate.remaining > 0
                    voiced = self.gate.feed(db, self.vad.is_speech(pcm, 16000))
                    segment = None if calibrating else self.segmenter.feed(pcm, voiced, next_stamp)
                    next_stamp += .02
                    self.update(message='校准中，请保持安静' if calibrating else ('检测到语音' if voiced else '持续检测中'), threshold=self.gate.threshold)
                    if segment:
                        sequence += 1
                        end = segment.start + len(segment.pcm) / 32000
                        frames = self.camera.get_frames(segment.start - .15, end)
                        if not frames or end - frames[-1][0] > 1:
                            raise RuntimeError('摄像头没有及时返回画面')
                        # Bound queued media memory: retain 10 JPEG frames per second.
                        encoded = []
                        previous = float('-inf')
                        for stamp, frame in frames:
                            if stamp - previous >= .095:
                                ok, jpeg = cv2.imencode('.jpg', frame)
                                if not ok:
                                    raise RuntimeError('摄像头 JPEG 编码失败')
                                encoded.append((stamp, jpeg.tobytes()))
                                previous = stamp
                        try:
                            self.jobs.put_nowait((sequence, segment, encoded))
                        except queue.Full:
                            # Freshness first: replace the waiting segment, keep active request.
                            try:
                                self.jobs.get_nowait()
                                self.jobs.task_done()
                                with self.lock:
                                    self.state['dropped'] += 1
                            except queue.Empty:
                                pass
                            self.jobs.put_nowait((sequence, segment, encoded))
        except Exception as exc:
            self.update(error=str(exc))
            self.stop()

    def worker(self):
        import cv2
        import numpy as np
        while not self.stop_event.is_set():
            try:
                number, segment, frames = self.jobs.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                with tempfile.TemporaryDirectory(prefix='mer_') as folder:
                    video, audio = save_media(cv2, np, segment, frames, Path(folder), 10)
                    result = run_inference(SimpleNamespace(video=video, audio=audio, gt=None,
                        api_base=self.config['mer_api_base'], api_key=self.config['mer_api_key'],
                        model=self.config['mer_model'], timeout=60, retries=0, retry_delay=1))
                    if result['status'] != 'ok':
                        raise RuntimeError(result['error'] or result['status'])
                    if not self.stop_event.is_set():
                        self.update(result=dict(prediction=result['prediction'], segment_id=number,
                            segment_kind=segment.kind, duration=len(segment.pcm)/32000,
                            updated_at=time.time(), api_latency=result['api_latency']), error='')
            except Exception as exc:
                if not self.stop_event.is_set():
                    self.update(error=str(exc))
            finally:
                self.jobs.task_done()
