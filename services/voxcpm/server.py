import base64
import io
import os
import secrets
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field


DEFAULT_MODEL = "openbmb/VoxCPM2"
FALLBACK_SAMPLE_RATE = 48000


class GenerateRequest(BaseModel):
    text: str = Field(min_length=1)
    reference_audio: Optional[str] = None
    prompt_audio: Optional[str] = None
    prompt_text: Optional[str] = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10
    normalize: bool = True
    denoise: bool = False


app = FastAPI(title="Voice Lab VoxCPM2 Service")
_model = None
_denoiser_loaded = False


def require_auth(authorization: str | None = Header(default=None)) -> None:
    api_key = os.environ.get("VOXCPM_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="VOXCPM_API_KEY is not configured.")

    expected = f"Bearer {api_key}"
    if authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized.")


def read_bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_model(load_denoiser: bool = False):
    global _model, _denoiser_loaded

    if _model is not None:
        if load_denoiser and not _denoiser_loaded:
            raise HTTPException(
                status_code=400,
                detail="Denoise was requested, but service started without VOXCPM_LOAD_DENOISER=true.",
            )
        return _model

    from voxcpm import VoxCPM

    model_id = os.environ.get("VOXCPM_MODEL", DEFAULT_MODEL)
    optimize = read_bool_env("VOXCPM_OPTIMIZE", True)
    _denoiser_loaded = read_bool_env("VOXCPM_LOAD_DENOISER", False) or load_denoiser
    load_kwargs = build_model_load_kwargs(
        optimize=optimize,
        load_denoiser=_denoiser_loaded,
    )

    _model = VoxCPM.from_pretrained(model_id, **load_kwargs)
    return _model


def build_model_load_kwargs(*, optimize: bool, load_denoiser: bool) -> dict[str, bool]:
    return {
        "optimize": optimize,
        "load_denoiser": load_denoiser,
    }


@app.get("/health", dependencies=[Depends(require_auth)])
def health() -> dict[str, object]:
    requested_device = os.environ.get("VOXCPM_DEVICE", "auto")

    return {
        "ready": _model is not None,
        "model": os.environ.get("VOXCPM_MODEL", DEFAULT_MODEL),
        "device": resolve_loaded_device(_model) or requested_device,
        "requested_device": requested_device,
        "denoiser_loaded": _denoiser_loaded,
    }


@app.post("/generate", dependencies=[Depends(require_auth)])
def generate(payload: GenerateRequest) -> Response:
    model = get_model(load_denoiser=payload.denoise)

    with tempfile.TemporaryDirectory(prefix="voice-lab-voxcpm-") as temp_dir:
        reference_path = write_data_uri(payload.reference_audio, temp_dir, "reference.wav")
        prompt_path = write_data_uri(payload.prompt_audio, temp_dir, "prompt.wav")

        if prompt_path and not payload.prompt_text:
            raise HTTPException(status_code=400, detail="prompt_text is required with prompt_audio.")

        if not reference_path and not prompt_path:
            raise HTTPException(status_code=400, detail="reference_audio or prompt_audio is required.")

        generate_kwargs = {
            "text": payload.text.strip(),
            "cfg_value": payload.cfg_value,
            "inference_timesteps": payload.inference_timesteps,
            "normalize": payload.normalize,
            "denoise": payload.denoise,
        }
        if prompt_path:
            generate_kwargs["prompt_wav_path"] = prompt_path
            generate_kwargs["prompt_text"] = payload.prompt_text.strip() if payload.prompt_text else None
        if reference_path:
            generate_kwargs["reference_wav_path"] = reference_path

        wav = model.generate(**generate_kwargs)

    audio = wav_to_bytes(wav, model=model)
    return Response(content=audio, media_type="audio/wav")


def write_data_uri(data_uri: Optional[str], temp_dir: str, filename: str) -> Optional[str]:
    if not data_uri:
        return None

    if "," not in data_uri:
        raise HTTPException(status_code=400, detail=f"{filename} must be a data URI.")

    _header, encoded = data_uri.split(",", 1)

    try:
        audio = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"{filename} is not valid base64.") from exc

    path = Path(temp_dir) / filename
    path.write_bytes(audio)
    return str(path)


def wav_to_bytes(wav: Any, model: Any = None) -> bytes:
    import numpy as np
    import soundfile as sf

    samples, sample_rate = resolve_generated_audio(wav, model=model)
    samples_array = np.asarray(samples)
    buffer = io.BytesIO()
    sf.write(buffer, samples_array, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def resolve_generated_audio(wav: Any, model: Any = None) -> tuple[Any, int]:
    samples = wav

    if isinstance(wav, tuple) and len(wav) == 2:
        sample_rate, samples = wav
        resolved_sample_rate = coerce_sample_rate(sample_rate)
        if resolved_sample_rate:
            return samples, resolved_sample_rate

    model_sample_rate = resolve_model_sample_rate(model)
    if model_sample_rate:
        return samples, model_sample_rate

    # VoxCPM2 documentation lists 48 kHz output. Prefer model metadata whenever available.
    return samples, FALLBACK_SAMPLE_RATE


def resolve_model_sample_rate(model: Any) -> Optional[int]:
    if model is None:
        return None

    for attribute_path in (("tts_model", "sample_rate"), ("sample_rate",)):
        value = model
        for attribute in attribute_path:
            try:
                value = getattr(value, attribute)
            except Exception:
                value = None
                break

        sample_rate = coerce_sample_rate(value)
        if sample_rate:
            return sample_rate

    return None


def resolve_loaded_device(model: Any) -> Optional[str]:
    if model is None:
        return None

    for attribute_path in (("tts_model", "device"), ("device",)):
        value = model
        for attribute in attribute_path:
            try:
                value = getattr(value, attribute)
            except Exception:
                value = None
                break

        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def coerce_sample_rate(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None

    if isinstance(value, (int, float)) and value > 0:
        return int(value)

    return None
