# VoxCPM2

Voice Lab uses VoxCPM2 through a separate authenticated FastAPI service in `services/voxcpm/`. The Next.js app never imports Torch or VoxCPM directly.

## Hardware

CUDA GPU is strongly recommended and usually required for practical long-form generation. CPU and Mac-local tests may be useful for wiring checks but should not be treated as the real workflow.

Target Python version: `3.11`. The default model is `openbmb/VoxCPM2`. The service pins `voxcpm==2.0.2` in `services/voxcpm/requirements.txt`.

## Local CUDA Setup

```bash
uv python install 3.11
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

The runtime check prints Python version, service imports, Torch/CUDA availability, CUDA device count and device names, `VOXCPM_MODEL`, and `VOXCPM_DEVICE`. It does not print bearer tokens, transcripts, audio paths, or base64 audio.

## Docker

```bash
docker build -f services/voxcpm/Dockerfile -t voice-lab-voxcpm2:cuda .
docker run --gpus all --rm \
  -p 127.0.0.1:8809:8809 \
  -e VOXCPM_API_KEY="$VOXCPM_API_KEY" \
  -e VOXCPM_MODEL="openbmb/VoxCPM2" \
  -e VOXCPM_DEVICE="cuda" \
  voice-lab-voxcpm2:cuda
```

## Next App Configuration

```bash
VOXCPM_ENABLED=true
VOXCPM_ENDPOINT_URL=http://127.0.0.1:8809/generate
VOXCPM_HEALTH_URL=http://127.0.0.1:8809/health
VOXCPM_API_KEY=replace-me
VOXCPM_ENDPOINT_MODE=native-wrapper
VOXCPM_TIMEOUT_MS=300000
```

## Private GPU Pattern

Run the service on a private GPU host, RunPod instance, or equivalent machine, then tunnel it:

```bash
ssh -N -L 8809:127.0.0.1:8809 root@<gpu-host>
```

Health check:

```bash
VOXCPM_API_KEY="replace-me" npm run check:voxcpm:health
```

The health check expects unauthenticated `/health` to return `401` and authenticated `/health` to return `200`. It does not load VoxCPM2, does not require CUDA, and does not run generation.

## Runtime Behavior

- `/health` verifies service/auth wiring and reports whether the model is already loaded.
- The VoxCPM2 model loads lazily on the first `/generate` request.
- First generation may take time while model weights load.
- The Python service returns WAV audio.
- The Next app writes WAV intermediates, merges/levels them, and masters the final MP3.

## Reference Workflow

1. Record or upload a clean reference clip.
2. Paste the exact words spoken in that clip.
3. Save the reference in the UI.
4. Generate target narration.

The exact transcript matters. Mismatched words, background noise, clipping, and inconsistent microphone distance can degrade the result.

## Security

- Do not expose the service without authentication.
- Prefer localhost, SSH tunnels, private networks, or authenticated HTTPS.
- Use a strong `VOXCPM_API_KEY`.
- Do not log base64 audio payloads or transcripts.
- Keep reference audio and generated runs in `VOICE_LAB_DATA_DIR`, outside the repo.

## Limitations

Voice Lab does not claim perfect cloning or seamless long-form continuity. Listen to final output before publishing.
