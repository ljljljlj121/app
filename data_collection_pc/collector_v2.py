#!/usr/bin/env python3
"""
板子端采集脚本 - collector.py
支持双模式采集：
1. 纯表情模式 (face_only): 不录音，固定捕捉 5 秒视频
2. 音视频互动模式 (av_vad): 5 秒内检测是否有人说话，无人说话 5 秒结束；有人说话则持续录制直到话说完
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from collections import deque
from pathlib import Path
from typing import Deque, Optional, Tuple

import cv2
import numpy as np
from flask import Flask, Response, jsonify, render_template, request

# ── 默认配置 ────────────────────────────────────────────────────────────
DEFAULT_SERVER    = "http://183.62.69.210:9004"
DEFAULT_RTSP      = "rtsp://127.0.0.1:8554/robot/camera-0"
DEFAULT_ROS_TOPIC = "/rkaudio_asr_raw"
DEFAULT_CAM_API   = "http://127.0.0.1:8081/api/v1/perception/camera/video-stream/start"
DEFAULT_AUDIO_OFFSET = 0.0  # 音频相对视频的延迟（秒），正数表示音频延后，负数表示音频提前

RECORD_SECONDS = 5
MAX_RECORD_SECONDS = 30  # VAD 模式最大超时时长(扩宽至30秒)
VAD_SILENCE_TIMEOUT = 1.5  # 说话后静音多久判定为说完 (默认值)
VAD_ENERGY_THRESHOLD = 200  # 默认音频 RMS 能量阈值

SAMPLE_RATE    = 16000
CHANNELS       = 1
SAMPLE_WIDTH   = 2   # int16

EMOTIONS = [
    ("happy",    "😊 开心"),
    ("sad",      "😢 悲伤"),
    ("angry",    "😠 愤怒"),
    ("fear",     "😨 恐惧"),
    ("disgust",  "🤢 厌恶"),
    ("surprise", "😲 惊讶"),
    ("neutral",  "😐 平静"),
]

app = Flask(__name__, template_folder="templates")
app.secret_key = secrets.token_hex(16)

state = {
    "status":   "idle",
    "mode":     "face_only",
    "progress": 0,
    "message":  "就绪",
    "last_id":  None,
    "error":    "",
}
state_lock = threading.Lock()
cfg = {}

def set_state(**kw):
    with state_lock:
        state.update(kw)


# ── 摄像头管理 ────────────────────────────────────────────────────────────
class CameraManager:
    def __init__(self, rtsp_url: str):
        self.rtsp_url = rtsp_url
        self.preview_jpeg = None
        self.frame_buffer: Deque[Tuple[float, np.ndarray]] = deque()
        self.lock = threading.Lock()
        self.running = True

    def start_api_stream(self, cam_api: str):
        if not cam_api:
            return
        try:
            payload = json.dumps({
                "camera_id": "camera-0",
                "width": 640,
                "height": 480,
                "fps": 12,
                "bitrate_kbps": 900,
                "gop": 24
            }).encode()
            req = urllib.request.Request(
                cam_api,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                print(f"[collector] 摄像头 API 响应: {resp.read()[:100]}")
            time.sleep(2)
        except Exception as e:
            print(f"[collector] 摄像头 API 跳过: {e}")

    def loop(self):
        while self.running:
            cap = cv2.VideoCapture(self.rtsp_url if self.rtsp_url else 0)
            if not cap.isOpened():
                time.sleep(1.0)
                continue
            while self.running:
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                now = time.monotonic()
                _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
                with self.lock:
                    self.preview_jpeg = buf.tobytes()
                    self.frame_buffer.append((now, frame))
                    # 缓存近 30 秒帧以支持长语音录制
                    cutoff = now - (MAX_RECORD_SECONDS + 5.0)
                    while self.frame_buffer and self.frame_buffer[0][0] < cutoff:
                        self.frame_buffer.popleft()
                time.sleep(0.04)
            cap.release()
            time.sleep(1.0)

    def get_frames(self, start_ts: float, end_ts: float):
        with self.lock:
            return [(t, f.copy()) for t, f in self.frame_buffer if start_ts <= t <= end_ts]

cam_mgr: Optional[CameraManager] = None


@app.route("/video_feed")
def video_feed():
    def gen():
        while True:
            if cam_mgr and cam_mgr.preview_jpeg:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + cam_mgr.preview_jpeg + b"\r\n")
            time.sleep(0.05)
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


# ── ROS 音频采集与能量检测 ───────────────────────────────────────────────
class AudioCollector:
    def __init__(self, topic: str):
        self.topic = topic
        self.chunks: Deque[Tuple[float, float, bytes, float]] = deque()  # start, end, data, rms
        self.lock = threading.Lock()
        self._sub = None

    def start(self):
        try:
            ros_path = Path("/opt/ros/noetic/lib/python3/dist-packages")
            if ros_path.is_dir() and str(ros_path) not in sys.path:
                sys.path.append(str(ros_path))
            import rospy
            from std_msgs.msg import UInt8MultiArray

            if not rospy.core.is_initialized():
                rospy.init_node("collector_node", anonymous=True, disable_signals=True)
            self._sub = rospy.Subscriber(self.topic, UInt8MultiArray, self._cb, queue_size=100)
            print(f"[collector] 订阅 ROS 音频: {self.topic}")
        except Exception as e:
            print(f"[collector] ROS 初始化失败 (将退回静音): {e}")

    def _calc_rms(self, data: bytes) -> float:
        if not data:
            return 0.0
        count = len(data) // 2
        if count == 0:
            return 0.0
        shorts = struct.unpack(f"{count}h", data[:count * 2])
        sum_squares = sum(s * s for s in shorts)
        return math.sqrt(sum_squares / count)

    def _cb(self, msg):
        try:
            data = bytes(msg.data)
        except Exception:
            return
        if not data:
            return
        end = time.monotonic()
        dur = len(data) / float(SAMPLE_RATE * 2)
        rms = self._calc_rms(data)
        with self.lock:
            self.chunks.append((end - dur, end, data, rms))
            cutoff = end - (MAX_RECORD_SECONDS + 5.0)
            while self.chunks and self.chunks[0][1] < cutoff:
                self.chunks.popleft()

    def get_pcm(self, start_ts: float, end_ts: float) -> bytes:
        # 按采样时间放置音频块，裁掉边界外样本，并为缺失的音频补静音。
        frame_bytes = CHANNELS * SAMPLE_WIDTH
        sample_count = max(0, round((end_ts - start_ts) * SAMPLE_RATE))
        pcm = bytearray(sample_count * frame_bytes)
        with self.lock:
            chunks = list(self.chunks)
        for s, e, data, _ in chunks:
            if e <= start_ts or s >= end_ts:
                continue
            offset = round((s - start_ts) * SAMPLE_RATE)
            source_start = max(0, -offset)
            dest_start = max(0, offset)
            count = min(len(data) // frame_bytes - source_start, sample_count - dest_start)
            if count > 0:
                pcm[dest_start * frame_bytes:(dest_start + count) * frame_bytes] = data[
                    source_start * frame_bytes:(source_start + count) * frame_bytes]
        return bytes(pcm)

    def get_latest_energy(self, duration: float = 0.5) -> float:
        now = time.monotonic()
        cutoff = now - duration
        with self.lock:
            recent = [rms for _, e, _, rms in self.chunks if e >= cutoff]
        if not recent:
            return 0.0
        return sum(recent) / len(recent)


audio_collector: Optional[AudioCollector] = None


# ── 录制与上传流程 ────────────────────────────────────────────────────
def tail_keep_seconds(silence_timeout: float) -> float:
    return min(1.0, max(0.0, silence_timeout * 0.25))


def tail_trim_seconds(silence_timeout: float) -> float:
    return silence_timeout - tail_keep_seconds(silence_timeout)


def do_record_and_upload(board_id: str, mode: str = "face_only"):
    tmpdir = Path(tempfile.mkdtemp(prefix="collector_"))
    audio_path  = tmpdir / "audio.wav"
    video_path  = tmpdir / "video.mp4"
    merged_path = tmpdir / "merged.mp4"

    set_state(status="recording", mode=mode, progress=0, message="正在准备录制…", error="")

    start_ts = time.monotonic()
    
    if mode == "face_only":
        # 模式一：固定纯表情 5 秒
        set_state(message="纯表情录制中 (5s)…")
        for i in range(RECORD_SECONDS):
            time.sleep(1.0)
            set_state(progress=int((i + 1) / RECORD_SECONDS * 80))
        end_ts = time.monotonic()
    else:
        # 模式二：VAD 语音活动检测模式
        has_spoken = False
        last_voice_ts = start_ts

        # 动态获取语音停顿判定超时时间以及声音灵敏度
        vad_silence_timeout = float(cfg.get("vad_silence", VAD_SILENCE_TIMEOUT))
        vad_energy_threshold = float(cfg.get("energy_threshold", VAD_ENERGY_THRESHOLD))

        while True:
            time.sleep(0.08)
            now = time.monotonic()
            elapsed = now - start_ts

            # 获取最近音频 RMS 能量 (0.5s 平滑检测)，严格采用动态阈值避免检测不到
            rms = audio_collector.get_latest_energy(0.5) if audio_collector else 0.0
            # 开口和后续停顿判定均使用本次录制配置的同一个门槛。
            is_speaking = rms > vad_energy_threshold

            if is_speaking:
                if not has_spoken:
                    has_spoken = True
                last_voice_ts = now

            if not has_spoken:
                # 前 5 秒内还没开口
                set_state(progress=min(75, int(elapsed / RECORD_SECONDS * 75)),
                          message=f"正在侦听 (当前音量:{int(rms)} | 需>{int(vad_energy_threshold)})")
                if elapsed >= RECORD_SECONDS:
                    set_state(message="5s 内未检测到说话，结束录制")
                    end_ts = time.monotonic()
                    break
            else:
                # 已经开口说话，彻底关闭5秒检测，等待话说完或触发最大限制超时
                silence_dur = now - last_voice_ts
                prog = min(80, int(75 + (elapsed / MAX_RECORD_SECONDS) * 5))
                
                # 细粒度的状态反馈，让操作员直观看到为何停顿断开
                if is_speaking:
                    set_state(progress=prog, message=f"持续录制中 🟢 (音量: {int(rms)} | 阈值: {int(vad_energy_threshold)})")
                else:
                    set_state(progress=prog, message=f"语音停顿中 🟡 ({silence_dur:.1f}s / {vad_silence_timeout}s)")
                
                if silence_dur >= vad_silence_timeout:
                    set_state(message="检测到说话结束")
                    # 直接裁掉设置停顿上限中的等待部分，不再检查底噪。
                    trim_seconds = tail_trim_seconds(vad_silence_timeout)
                    end_ts = max(start_ts + 0.5, now - trim_seconds)
                    print(f"[collector] 按停顿设置裁切 {trim_seconds:.3f}s，保留 {tail_keep_seconds(vad_silence_timeout):.3f}s 收尾")
                    break
                
                if elapsed >= MAX_RECORD_SECONDS:
                    set_state(message="达到最大时长限制，结束录制")
                    end_ts = time.monotonic()
                    break

    actual_duration = max(0.5, end_ts - start_ts)
    
    # 关键修改：此时物理录制已脱出循环，标记为 merging，前端检测到后立刻发出提示音
    set_state(progress=85, message="录制已停止，正在编码音视频…", status="merging")

    # 编码可能耗时数秒，必须在编码前取出音频，避免滚动缓存淘汰样本。
    recorded_pcm = audio_collector.get_pcm(start_ts, end_ts) if mode != "face_only" and audio_collector else None
    # 音视频使用同一个安全裁切终点。
    frames = cam_mgr.get_frames(start_ts, end_ts) if cam_mgr else []
    if frames:
        h, w = frames[0][1].shape[:2]
        # 固定时间轴重采样；丢帧时重复最近帧，而非缩短整段视频。
        frame_count = max(1, math.ceil(actual_duration * 12))
        real_fps = frame_count / actual_duration
        raw_v = tmpdir / "raw.mp4"
        writer = cv2.VideoWriter(str(raw_v), cv2.VideoWriter_fourcc(*"mp4v"), real_fps, (w, h))
        frame_index = 0
        for i in range(frame_count):
            frame_ts = start_ts + i / real_fps
            while frame_index + 1 < len(frames) and frames[frame_index + 1][0] <= frame_ts:
                frame_index += 1
            writer.write(frames[frame_index][1])
        writer.release()
        subprocess.run([
            "ffmpeg", "-y", "-i", str(raw_v),
            "-vcodec", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", str(video_path)
        ], capture_output=True)

    # 2. 保存音频
    target_bytes = round(SAMPLE_RATE * actual_duration) * CHANNELS * SAMPLE_WIDTH
    if mode == "face_only" or not audio_collector:
        pcm = bytes(target_bytes)
    else:
        pcm = recorded_pcm
        if len(pcm) < target_bytes:
            pcm += bytes(target_bytes - len(pcm))
        else:
            pcm = pcm[:target_bytes]

    with wave.open(str(audio_path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)

    # 3. 合成有声视频
    if video_path.exists() and audio_path.exists():
        audio_offset = float(cfg.get("audio_offset", DEFAULT_AUDIO_OFFSET))
        ffmpeg_cmd = ["ffmpeg", "-y", "-i", str(video_path)]
        if abs(audio_offset) > 1e-4:
            ffmpeg_cmd.extend(["-itsoffset", str(audio_offset)])
        # 正向补偿使音频尾部延后，视频必须延长，不能用原时长裁掉语音。
        positive_offset = max(0.0, audio_offset)
        ffmpeg_cmd.extend([
            "-i", str(audio_path),
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p", "-af", "apad",
            "-vf", f"tpad=stop_mode=clone:stop_duration={positive_offset}",
            "-t", str(actual_duration + positive_offset), str(merged_path)
        ])
        subprocess.run(ffmpeg_cmd, capture_output=True)

    # 合成完毕，开始上传
    set_state(progress=90, message="正在上传至服务器…", status="uploading")

    server = cfg.get("server", DEFAULT_SERVER).rstrip("/")
    try:
        boundary = ("----CollectorBoundary" + secrets.token_hex(8)).encode()
        def part_field(name: str, value: str) -> bytes:
            return (b"--" + boundary + b"\r\n"
                    b'Content-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n'
                    + value.encode() + b"\r\n")

        def part_file(field: str, filename: str, data: bytes) -> bytes:
            return (b"--" + boundary + b"\r\n"
                    b'Content-Disposition: form-data; name="' + field.encode()
                    + b'"; filename="' + filename.encode() + b'"\r\n'
                    b"Content-Type: application/octet-stream\r\n\r\n"
                    + data + b"\r\n")

        body = part_field("board_id", board_id)
        has_audio_str = "true" if mode != "face_only" else "false"
        body += part_field("has_audio", has_audio_str)
        if audio_path.exists(): body += part_file("audio", "audio.wav", audio_path.read_bytes())
        if video_path.exists(): body += part_file("video", "video.mp4", video_path.read_bytes())
        if merged_path.exists(): body += part_file("merged", "merged.mp4", merged_path.read_bytes())
        body += b"--" + boundary + b"--\r\n"

        req = urllib.request.Request(
            f"{server}/api/upload_sample",
            data=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary.decode()}",
                "X-Upload-Token": cfg.get("password", "xzy123456!"),
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())

        if result.get("ok"):
            set_state(progress=100, status="done", message="上传成功，请选择情绪标签", last_id=result.get("id"))
        else:
            set_state(status="error", error=result.get("msg", "上传失败"))
    except Exception as e:
        set_state(status="error", error=f"上传网络错误: {e}")
    finally:
        for p in (audio_path, video_path, merged_path, tmpdir / "raw.mp4"):
            p.unlink(missing_ok=True)
        try: tmpdir.rmdir()
        except Exception: pass


# ── API 路由 ──────────────────────────────────────────────────────────
@app.route("/api/start", methods=["POST"])
def api_start():
    data = request.json or {}
    mode = data.get("mode", "face_only")
    with state_lock:
        # 新增拦截 merging 状态
        if state["status"] in ("recording", "merging", "recorded", "uploading"):
            return jsonify({"ok": False, "msg": "正在录制中"}), 409
    threading.Thread(
        target=do_record_and_upload,
        args=(cfg.get("board_id", "robot"), mode),
        daemon=True
    ).start()
    return jsonify({"ok": True})

@app.route("/api/status")
def api_status():
    with state_lock:
        return jsonify(dict(state))

@app.route("/api/config/audio_offset", methods=["GET", "POST"])
def api_audio_offset():
    if request.method == "POST":
        data = request.json or {}
        try:
            val = float(data.get("offset", 0.0))
            cfg["audio_offset"] = val
            return jsonify({"ok": True, "offset": val, "msg": f"音视频时间差已更新为 {val}s"})
        except (ValueError, TypeError):
            return jsonify({"ok": False, "msg": "非法的时间差数值"}), 400
    return jsonify({"ok": True, "offset": cfg.get("audio_offset", DEFAULT_AUDIO_OFFSET)})

@app.route("/api/config/vad_silence", methods=["GET", "POST"])
def api_vad_silence():
    if request.method == "POST":
        data = request.json or {}
        try:
            val = float(data.get("timeout", VAD_SILENCE_TIMEOUT))
            if val < 0.5 or val > 6.0:
                return jsonify({"ok": False, "msg": "建议设置在 0.5 ~ 6.0 秒之间"}), 400
            cfg["vad_silence"] = val
            return jsonify({"ok": True, "timeout": val, "msg": f"语音停顿超时已更新为 {val}s"})
        except (ValueError, TypeError):
            return jsonify({"ok": False, "msg": "非法数值"}), 400
    return jsonify({"ok": True, "timeout": cfg.get("vad_silence", VAD_SILENCE_TIMEOUT)})

@app.route("/api/config/vad_threshold", methods=["GET", "POST"])
def api_vad_threshold():
    if request.method == "POST":
        data = request.json or {}
        try:
            val = float(data.get("threshold", VAD_ENERGY_THRESHOLD))
            cfg["energy_threshold"] = val
            return jsonify({"ok": True, "threshold": val, "msg": f"灵敏度阈值已更新为 {val}"})
        except (ValueError, TypeError):
            return jsonify({"ok": False, "msg": "非法数值"}), 400
    return jsonify({"ok": True, "threshold": cfg.get("energy_threshold", VAD_ENERGY_THRESHOLD)})

@app.route("/api/submit_emotion", methods=["POST"])
def api_submit_emotion():
    data = request.json or {}
    emotion = data.get("emotion", "")
    is_invalid = bool(data.get("is_invalid", False))
    sample_id = state.get("last_id")

    if not sample_id:
        return jsonify({"ok": False, "msg": "无样本 ID"}), 400
    if emotion == "__skip__":
        set_state(status="idle", message="已跳过，可继续录制", last_id=None)
        return jsonify({"ok": True})

    try:
        req = urllib.request.Request(
            f"{cfg.get('server')}/api/upload_sample/{sample_id}/emotion",
            data=json.dumps({"emotion": emotion, "is_invalid": is_invalid}).encode(),
            headers={"Content-Type": "application/json", "X-Upload-Token": cfg.get("password")},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
        if result.get("ok"):
            set_state(status="idle", message="标注完成 ✓ 可继续录制", last_id=None)
            return jsonify({"ok": True})
        return jsonify({"ok": False, "msg": result.get("msg")}), 400
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 500


# ── 复核代理 API ───────────────────────────────────────────────────────
def _server_req(path: str, method: str = "GET", payload: dict = None):
    url = f"{cfg.get('server').rstrip('/')}{path}"
    headers = {"X-Upload-Token": cfg.get("password")}
    body = json.dumps(payload).encode() if payload else None
    if body:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return True, json.loads(resp.read())
    except Exception as e:
        return False, str(e)


@app.route("/api/review/samples")
def api_review_samples():
    filter_mode = request.args.get("filter", "pending")
    ok, data = _server_req("/api/samples")
    if not ok:
        return jsonify({"ok": False, "msg": data}), 500

    samples = data if isinstance(data, list) else []
    if filter_mode == "pending":
        samples = [s for s in samples if not s.get("is_reviewed") and not s.get("is_invalid")]
        random.shuffle(samples)
    else:
        samples.sort(key=lambda s: s.get("created_at", ""), reverse=True)

    safe_samples = []
    for s in samples:
        safe_samples.append({
            "id": s.get("id"),
            "created_at": s.get("created_at"),
            "board_id": s.get("board_id"),
            "review_count": s.get("review_count", 0),
            "is_reviewed": s.get("is_reviewed", False),
            "is_invalid": s.get("is_invalid", False),
            "has_audio": bool(s.get("has_audio", False))
        })

    return jsonify({"ok": True, "samples": safe_samples})

@app.route("/api/review/reindex", methods=["POST"])
def api_review_reindex():
    ok, data = _server_req("/api/samples/reindex", "POST")
    if not ok:
        return jsonify({"ok": False, "msg": str(data)}), 500
    return jsonify({
        "ok": data.get("ok", True),
        "count": data.get("count", 0),
        "deleted": data.get("deleted", 0),
        "msg": data.get("msg", "")
    })

@app.route("/api/review/lock/<sample_id>", methods=["POST"])
def api_review_lock(sample_id):
    ok, data = _server_req(f"/api/samples/{sample_id}/lock", "POST", {"board_id": cfg.get("board_id")})
    return jsonify({"ok": ok, "msg": data if not ok else ""})


@app.route("/api/review/unlock/<sample_id>", methods=["POST"])
def api_review_unlock(sample_id):
    _server_req(f"/api/samples/{sample_id}/unlock", "POST", {"board_id": cfg.get("board_id")})
    return jsonify({"ok": True})


@app.route("/api/review/submit/<sample_id>", methods=["POST"])
def api_review_submit(sample_id):
    data = request.json or {}
    ok, result = _server_req(f"/api/samples/{sample_id}/review", "POST", {
        "review_emotion": data.get("review_emotion"),
        "is_invalid": bool(data.get("is_invalid", False)),
        "board_id": cfg.get("board_id"),
    })
    return jsonify({"ok": ok, "data": result if ok else None, "msg": result if not ok else ""})


@app.route("/api/review/proxy_media")
def api_review_proxy_media():
    path = request.args.get("path", "")
    url = f"{cfg.get('server').rstrip('/')}/data/{path}"
    req = urllib.request.Request(url, headers={"X-Upload-Token": cfg.get("password")})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
            ctype = resp.headers.get("Content-Type", "application/octet-stream")
        r = app.make_response(content)
        r.headers["Content-Type"] = ctype
        return r
    except Exception as e:
        return str(e), 500


@app.route("/")
def index():
    return render_template(
        "collector.html",
        server=cfg.get("server", DEFAULT_SERVER),
        board_id=cfg.get("board_id", "unknown"),
        emotions=EMOTIONS
    )


def get_board_id():
    try:
        result = subprocess.run(["ip", "link", "show", "wlan0"], capture_output=True, text=True, timeout=3)
        m = re.search(r"link/ether\s+([\da-fA-F:]{17})", result.stdout)
        if m: return m.group(1).replace(":", "")[-4:]
    except Exception: pass
    import socket
    return socket.gethostname()[:12]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server",    default=DEFAULT_SERVER)
    parser.add_argument("--password",  default="xzy123456!")
    parser.add_argument("--rtsp",      default=DEFAULT_RTSP)
    parser.add_argument("--ros-topic", default=DEFAULT_ROS_TOPIC)
    parser.add_argument("--cam-api",   default=DEFAULT_CAM_API)
    parser.add_argument("--board-id",  default=None)
    parser.add_argument("--port",      default=8088, type=int)
    args = parser.parse_args()

    cfg.update(vars(args))
    cfg["board_id"] = args.board_id or get_board_id()

    cam_mgr = CameraManager(args.rtsp)
    if args.cam_api:
        cam_mgr.start_api_stream(args.cam_api)
    threading.Thread(target=cam_mgr.loop, daemon=True).start()

    audio_collector = AudioCollector(args.ros_topic)
    audio_collector.start()

    app.run(host="0.0.0.0", port=args.port, debug=False, threaded=True)
