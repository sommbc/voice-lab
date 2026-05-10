# VoxCPM2 Service

Native FastAPI wrapper for `openbmb/VoxCPM2`. The Next.js app talks to this service over HTTP only; it does not import Torch or VoxCPM.

## Local CUDA Setup

```bash
uv python install 3.11
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

## Docker / RunPod

```bash
docker build -f services/voxcpm/Dockerfile -t voiceover-voxcpm2:cuda .
docker run --gpus all --rm \
  -p 127.0.0.1:8809:8809 \
  -e VOXCPM_API_KEY="$VOXCPM_API_KEY" \
  -e VOXCPM_MODEL="openbmb/VoxCPM2" \
  -e VOXCPM_DEVICE="cuda" \
  voiceover-voxcpm2:cuda
```

RunPod/private endpoint pattern:

```bash
ssh -N -L 8809:127.0.0.1:8809 root@<runpod-host>
```

Point the Next app at the tunnel:

```bash
VOXCPM_ENABLED=true
VOXCPM_ENDPOINT_URL=http://127.0.0.1:8809/generate
VOXCPM_HEALTH_URL=http://127.0.0.1:8809/health
VOXCPM_API_KEY=replace-me
```

Health check:

```bash
curl -H "Authorization: Bearer $VOXCPM_API_KEY" http://127.0.0.1:8809/health
```

Do not expose this service as an unauthenticated public endpoint. Bind it to localhost, use an SSH tunnel/private network, or put authenticated HTTPS in front of it.
