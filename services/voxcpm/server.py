import base64
import io
import os
import secrets
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field


DEFAULT_MODEL = "openbmb/VoxCPM2"


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
    device = os.environ.get("VOXCPM_DEVICE") or None
    optimize = read_bool_env("VOXCPM_OPTIMIZE", True)
    _denoiser_loaded = read_bool_env("VOXCPM_LOAD_DENOISER", False) or load_denoiser

    _model = VoxCPM.from_pretrained(
        model_id,
        device=device,
        optimize=optimize,
        load_denoiser=_denoiser_loaded,
    )
    return _model


@app.get("/health", dependencies=[Depends(require_auth)])
def health() -> dict[str, object]:
    return {
        "ready": _model is not None,
        "model": os.environ.get("VOXCPM_MODEL", DEFAULT_MODEL),
        "device": os.environ.get("VOXCPM_DEVICE", "auto"),
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

    audio = wav_to_bytes(wav)
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


def wav_to_bytes(wav) -> bytes:
    if isinstance(wav, tuple) and len(wav) == 2:
        sample_rate, samples = wav
    else:
        sample_rate = 16000
        samples = wav

    samples_array = np.asarray(samples)
    buffer = io.BytesIO()
    sf.write(buffer, samples_array, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()
