"""Run: python -m unittest discover -s data_collection/tests -v"""
import ast
import math
import struct
import threading
import unittest
from collections import deque
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = (ROOT / "data_collection_pc/collector_v2.py", ROOT / "data_collection/collector_v2.py", ROOT / "data_collection/data_collection/collector_v2.py")


def load(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = {"tail_keep_seconds", "tail_trim_seconds", "AudioCollector"}
    nodes = [n for n in tree.body if getattr(n, "name", None) in names]
    ns = dict(math=math, struct=struct, threading=threading, deque=deque,
              SAMPLE_RATE=16000, SAMPLE_WIDTH=2, CHANNELS=1)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), ns)
    return tree, ns


class Clock:
    def __init__(self): self.now = 0
    def monotonic(self): return self.now
    def sleep(self, seconds): self.now += seconds


def run_recording_prefix(path, mode, pause, energy, threshold=200):
    tree, ns = load(path)
    clock = Clock()
    fn = next(n for n in tree.body if getattr(n, "name", None) == "do_record_and_upload")
    prefix = []
    for node in fn.body:
        prefix.append(node)
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "actual_duration" for t in node.targets):
            break
    ns.update(time=clock, Path=Path, tempfile=SimpleNamespace(mkdtemp=lambda **kw: "."),
              mode=mode, set_state=lambda **kw: None, RECORD_SECONDS=5, MAX_RECORD_SECONDS=30,
              VAD_SILENCE_TIMEOUT=1.5, VAD_ENERGY_THRESHOLD=200,
              cfg={"vad_silence": pause, "energy_threshold": threshold},
              audio_collector=SimpleNamespace(get_latest_energy=lambda duration: energy(clock.now)))
    exec(compile(ast.Module(body=prefix, type_ignores=[]), str(path), "exec"), ns)
    return clock.now, ns["end_ts"]


class TailPolicyTests(unittest.TestCase):
    def test_configured_threshold_applies_after_first_voice(self):
        for path in SCRIPTS:
            with self.subTest(path=path):
                energy = lambda t: 300 if t <= 1 else 80
                stopped, end = run_recording_prefix(path, "av_vad", 1.5, energy, threshold=200)
                self.assertLess(stopped, 3, "80 RMS must count as a pause when the configured threshold is 200")
                self.assertAlmostEqual(stopped - end, 1.125)
                stopped, end = run_recording_prefix(path, "av_vad", 1.5, energy, threshold=60)
                self.assertGreaterEqual(stopped, 30, "80 RMS must keep recording when the configured threshold is 60")
                self.assertEqual(stopped, end)

    def test_configured_pause_only(self):
        for path in SCRIPTS:
            with self.subTest(path=path):
                _, ns = load(path)
                for pause, keep, cut in [(0.5, 0.125, 0.375), (1.5, 0.375, 1.125), (4, 1, 3), (6, 1, 5)]:
                    self.assertEqual(ns["tail_keep_seconds"](pause), keep)
                    self.assertEqual(ns["tail_trim_seconds"](pause), cut)

    def test_background_noise_does_not_cancel_tail_cut(self):
        for path in SCRIPTS:
            for pause in [0.5, 1.5, 6]:
                with self.subTest(path=path, pause=pause):
                    # 12 RMS blocked the old near-zero check; now it must still crop.
                    stopped, end = run_recording_prefix(path, "av_vad", pause, lambda t: 300 if t <= 1 else 12)
                    self.assertAlmostEqual(stopped - end, pause - min(1, pause / 4))
                    self.assertGreater(end, 1, "Keep the complete opening phrase")

    def test_other_stop_reasons_do_not_crop(self):
        for path in SCRIPTS:
            for mode, energy in [("face_only", lambda t: 0), ("av_vad", lambda t: 12), ("av_vad", lambda t: 300)]:
                with self.subTest(path=path, mode=mode):
                    stopped, end = run_recording_prefix(path, mode, 1.5, energy)
                    self.assertEqual(stopped, end)

    def test_pcm_boundaries_keep_original_samples(self):
        for path in SCRIPTS:
            with self.subTest(path=path):
                _, ns = load(path)
                collector = ns["AudioCollector"]("test")
                collector.chunks.append((0, 2, struct.pack("<32000h", *([300] * 32000)), 300))
                samples = struct.unpack("<16000h", collector.get_pcm(0.5, 1.5))
                self.assertEqual(samples, (300,) * 16000)


if __name__ == "__main__": unittest.main()
