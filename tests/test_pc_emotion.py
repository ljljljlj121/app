import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'data_collection_pc'))
from pc_emotion import EmotionService, SpeechSegmenter

QUIET = b'\0' * 640
VOICE = (1000).to_bytes(2, 'little', signed=True) * 320


class PcEmotionTests(unittest.TestCase):
    def test_idle_does_not_emit_or_accumulate(self):
        segmenter = SpeechSegmenter()
        for n in range(10000):
            self.assertIsNone(segmenter.feed(QUIET, False, n*.02))
        self.assertEqual(segmenter.frames, [])
        self.assertIsNone(segmenter.feed(VOICE, True, 200))
        for n in range(29):
            self.assertIsNone(segmenter.feed(QUIET, False, 200.02+n*.02))
        segment = segmenter.feed(QUIET, False, 200.6)
        self.assertEqual(segment.start, 200)
        self.assertEqual(segment.kind, 'speech')
        self.assertEqual(len(segment.pcm), 31*640)

    def test_speech_limit_begins_after_onset(self):
        segmenter = SpeechSegmenter()
        for n in range(749):
            self.assertIsNone(segmenter.feed(VOICE, True, 3600+n*.02))
        self.assertEqual(segmenter.feed(VOICE, True, 3614.98).kind, 'speech_limit')

    def make_service(self):
        return EmotionService(None, SimpleNamespace(mer_sink=None), dict(mer_threshold=200))

    def test_inference_pauses_input_and_stop_prevents_new_round(self):
        service = self.make_service()
        entered, release = threading.Event(), threading.Event()
        calls = []
        def recognize(segment, number):
            calls.append(number)
            entered.set()
            release.wait(2)
        service.recognize = recognize
        with patch.dict(sys.modules, {'openai': SimpleNamespace()}):
            service.start()
        try:
            service.feed(VOICE + QUIET*30, 0)
            self.assertTrue(entered.wait(1))
            service.feed(VOICE + QUIET*30, 10)
            self.assertTrue(service.inputs.empty(), 'no utterance queue during inference')
            service.stop()
        finally:
            release.set()
            service.thread.join(2)
        self.assertFalse(service.thread.is_alive())
        self.assertEqual(calls, [1])
        self.assertIsNone(service.audio.mer_sink)

    def test_result_returns_to_listening(self):
        service = self.make_service()
        calls, first = [], threading.Event()
        def recognize(segment, number):
            calls.append(number)
            first.set()
            if number == 2:
                service.stop()
        service.recognize = recognize
        with patch.dict(sys.modules, {'openai': SimpleNamespace()}):
            service.start()
        try:
            service.feed(VOICE + QUIET*30, 0)
            self.assertTrue(first.wait(1))
            deadline = time.monotonic()+1
            while not service.accepting and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(service.accepting)
            service.feed(VOICE + QUIET*30, 100)
            service.thread.join(2)
            self.assertEqual(calls, [1, 2])
        finally:
            service.stop()
            service.thread.join(2)


if __name__ == '__main__':
    unittest.main()
