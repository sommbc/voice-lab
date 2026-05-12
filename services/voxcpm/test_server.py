import inspect
import unittest
from types import SimpleNamespace

from services.voxcpm.server import (
    FALLBACK_SAMPLE_RATE,
    build_model_load_kwargs,
    resolve_generated_audio,
    resolve_loaded_device,
)


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


class ModelLoadOptionTests(unittest.TestCase):
    def test_model_load_kwargs_do_not_forward_unsupported_device(self) -> None:
        load_kwargs = build_model_load_kwargs(optimize=False, load_denoiser=True)

        self.assertEqual(load_kwargs, {"optimize": False, "load_denoiser": True})
        self.assertNotIn("device", load_kwargs)

    def test_model_load_kwargs_match_installed_voxcpm_signature_when_available(self) -> None:
        try:
            from voxcpm import VoxCPM
        except ModuleNotFoundError:
            self.skipTest("voxcpm is not installed in this Python environment")

        from_pretrained_parameters = inspect.signature(VoxCPM.from_pretrained).parameters
        init_parameters = inspect.signature(VoxCPM).parameters
        load_kwargs = build_model_load_kwargs(optimize=False, load_denoiser=True)

        self.assertIn("optimize", from_pretrained_parameters)
        self.assertIn("load_denoiser", from_pretrained_parameters)
        self.assertIn("optimize", init_parameters)
        self.assertIn("enable_denoiser", init_parameters)
        self.assertNotIn("device", init_parameters)

    def test_loaded_device_reads_model_metadata_when_available(self) -> None:
        model = SimpleNamespace(tts_model=SimpleNamespace(device="mps"))

        self.assertEqual(resolve_loaded_device(model), "mps")


if __name__ == "__main__":
    unittest.main()
