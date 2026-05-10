import unittest
from types import SimpleNamespace

from services.voxcpm.server import FALLBACK_SAMPLE_RATE, resolve_generated_audio


class SampleRateResolutionTests(unittest.TestCase):
    def test_tuple_output_uses_tuple_sample_rate(self) -> None:
        samples, sample_rate = resolve_generated_audio((44100, [0.0, 0.1]))

        self.assertEqual(samples, [0.0, 0.1])
        self.assertEqual(sample_rate, 44100)

    def test_raw_samples_use_tts_model_sample_rate_when_available(self) -> None:
        model = SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000))
        samples, sample_rate = resolve_generated_audio([0.0, 0.1], model=model)

        self.assertEqual(samples, [0.0, 0.1])
        self.assertEqual(sample_rate, 48000)

    def test_raw_samples_use_model_sample_rate_when_available(self) -> None:
        model = SimpleNamespace(sample_rate=24000)
        samples, sample_rate = resolve_generated_audio([0.0, 0.1], model=model)

        self.assertEqual(samples, [0.0, 0.1])
        self.assertEqual(sample_rate, 24000)

    def test_raw_samples_fallback_is_explicit(self) -> None:
        samples, sample_rate = resolve_generated_audio([0.0, 0.1])

        self.assertEqual(samples, [0.0, 0.1])
        self.assertEqual(sample_rate, FALLBACK_SAMPLE_RATE)


if __name__ == "__main__":
    unittest.main()
