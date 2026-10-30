import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'data_collection'))
from mer_stream_core import Segmenter, VoiceGate


class StreamingTests(unittest.TestCase):
    def feed(self, segmenter, voiced, count, offset=0):
        return [result for i in range(count)
                if (result := segmenter.feed(b'\0' * 640, voiced, (i + offset) * .02))]

    def test_default_idle_three_seconds(self):
        results = self.feed(Segmenter(), False, 300)
        self.assertEqual([len(r.pcm) for r in results], [96000, 96000])

    def test_idle_five_seconds(self):
        results = self.feed(Segmenter(idle=5), False, 500)
        self.assertEqual([r.kind for r in results], ['idle', 'idle'])
        self.assertEqual([len(r.pcm) for r in results], [160000, 160000])

    def test_utterance_waits_for_pause(self):
        s = Segmenter()
        self.assertEqual(self.feed(s, True, 300), [])
        self.assertEqual(self.feed(s, False, 29, 300), [])
        results = self.feed(s, False, 1, 329)
        self.assertEqual(results[0].kind, 'speech')
        self.assertEqual(len(results[0].pcm), 330 * 640)

    def test_forced_cut_continues_speech(self):
        s = Segmenter()
        results = self.feed(s, True, 1000)
        self.assertEqual(results[0].kind, 'speech_limit')
        self.assertEqual(len(results[0].pcm), 750 * 640)
        self.assertTrue(s.speaking)
        self.assertEqual(self.feed(s, False, 30, 1000)[0].kind, 'speech')

    def test_click_does_not_trigger_utterance(self):
        s = Segmenter()
        self.feed(s, False, 100)
        self.feed(s, True, 1, 100)
        self.assertFalse(s.speaking)
        self.assertEqual(self.feed(s, False, 149, 101)[0].kind, 'idle')

    def test_calibration_and_gate(self):
        gate = VoiceGate()
        for _ in range(75):
            self.assertFalse(gate.feed(-50, True))
        self.assertEqual(gate.threshold, -40)
        self.assertFalse(gate.feed(-45, True))
        self.assertFalse(gate.feed(-30, False))
        self.assertTrue(gate.feed(-30, True))


if __name__ == '__main__':
    unittest.main()
