# Voice Lab VoxCPM2 Service

Native FastAPI wrapper for `openbmb/VoxCPM2`. The Next.js app talks to this service over authenticated HTTP only; it does not import Torch or VoxCPM.

## Status

The service wrapper, auth, health check, and non-generation tests are in place. Live generation still depends on the local Python/PyTorch/device setup. CUDA is expected to be fastest. Apple Silicon MPS may work but still needs validation for long-form workloads.

`VOXCPM_DEVICE` is a requested/diagnostic value for local checks. VoxCPM 2.0.2 does not accept an explicit device argument in `VoxCPM.from_pretrained`; the model runtime selects CUDA when available, otherwise MPS when available, otherwise CPU.

Target Python version: `3.11`. The service defaults to `openbmb/VoxCPM2` and pins `voxcpm==2.0.2` through `requirements.txt`.

The service does not load the model at startup or during `/health`. Model load happens on the first `/generate` request and may take time. The service returns WAV audio; the Next.js app owns WAV intermediates and final MP3 mastering.

Keep the Python virtual environment outside the repository. A repo-root `.venv` can interfere with the Next/Turbopack build.

## Apple Silicon Validation Setup

```bash
uv python install 3.11
uv venv "$HOME/.venvs/voice-lab-voxcpm" --python 3.11
source "$HOME/.venvs/voice-lab-voxcpm/bin/activate"
uv pip install torch torchaudio
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_DEVICE=mps npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=mps uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

Treat this as a validation path until short and long-form generation are proven on Apple Silicon. `VOXCPM_DEVICE=mps` is kept as a runner/check signal, not as a forced model-load argument.

## Local CUDA Setup

```bash
uv python install 3.11
uv venv "$HOME/.venvs/voice-lab-voxcpm" --python 3.11
source "$HOME/.venvs/voice-lab-voxcpm/bin/activate"
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_DEVICE=cuda npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

`npm run check:voxcpm` prints Python version, core imports, Torch CUDA/MPS availability, CUDA device count and names, `VOXCPM_MODEL`, and the requested `VOXCPM_DEVICE`. It never prints `VOXCPM_API_KEY`, transcripts, audio paths, or base64 audio.

## Hugging Face Cache

The Python runtime may download/cache `openbmb/VoxCPM2` through Hugging Face tooling. Set `HF_TOKEN` only when needed for model access or rate limits. If you set `HF_HOME` or `HF_HUB_CACHE`, keep them outside this repository.

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

## Remote GPU Pattern

```bash
ssh -N -L 8809:127.0.0.1:8809 root@<gpu-host>
```

Point the Next app at the tunnel:

```bash
VOXCPM_ENABLED=true
VOXCPM_ENDPOINT_URL=http://127.0.0.1:8809/generate
VOXCPM_HEALTH_URL=http://127.0.0.1:8809/health
VOXCPM_API_KEY=replace-me
```

## Health Check

```bash
VOXCPM_API_KEY="replace-me" npm run check:voxcpm:health
```

Expected result:

```text
unauthenticated /health: 401
authenticated /health: 200
health check: ok
```

Manual equivalent:

```bash
curl -i http://127.0.0.1:8809/health
curl -i -H "Authorization: Bearer $VOXCPM_API_KEY" http://127.0.0.1:8809/health
```

Do not expose this service as an unauthenticated public endpoint. Bind it to localhost, use an SSH tunnel or private network, or put authenticated HTTPS in front of it.
