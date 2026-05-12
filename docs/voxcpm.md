# VoxCPM2 Runtime

Voice Lab uses VoxCPM2 through a separate authenticated FastAPI service in `services/voxcpm/`. The Next.js app never imports Torch or VoxCPM directly.

## Current Runtime Status

- Default model: `openbmb/VoxCPM2`.
- Python target: `3.11`.
- VoxCPM package pin: `voxcpm==2.0.2` in `services/voxcpm/requirements.txt`.
- CUDA is expected to be the fastest practical path.
- Apple Silicon MPS may work, but long-form workloads still need validation.
- `VOXCPM_DEVICE` is a requested/diagnostic value for local checks. VoxCPM 2.0.2 does not accept an explicit device argument in `VoxCPM.from_pretrained`; the model runtime selects CUDA when available, otherwise MPS when available, otherwise CPU.
- Live VoxCPM2 generation is not yet fully proven across hardware targets.

Do not treat import checks or `/health` checks as proof that generation quality, speed, or long-form stability is validated.

Keep the Python virtual environment outside the repository. A repo-root `.venv` can interfere with the Next/Turbopack build.

## Hugging Face Model Cache

VoxCPM2 weights are downloaded through the Python runtime and Hugging Face cache. Voice Lab does not use hosted Hugging Face inference.

Optional environment variables:

```bash
HF_TOKEN=
HF_HOME=
HF_HUB_CACHE=
```

Use `HF_TOKEN` only when needed for model access or rate limits. Keep `HF_HOME` and `HF_HUB_CACHE` outside this repository so model weights are never staged by git.

## Apple Silicon Setup

This path is for validation. Apple Silicon MPS support is not yet proven for long-form workloads. `VOXCPM_DEVICE=mps` is kept as a runner/check signal, not as a forced model-load argument.

```bash
uv python install 3.11
uv venv "$HOME/.venvs/voice-lab-voxcpm" --python 3.11
source "$HOME/.venvs/voice-lab-voxcpm/bin/activate"
uv pip install torch torchaudio
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_DEVICE=mps npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=mps uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

Expected validation work:

- Confirm PyTorch reports MPS availability.
- Confirm the service imports and starts.
- Confirm `/health` auth behavior.
- Run one short private generation.
- Run one long-form multi-section generation.
- Listen to the final MP3 and inspect intermediate WAV behavior before making quality claims.

## CUDA/Linux Setup

CUDA is the expected fastest setup for practical generation. `VOXCPM_DEVICE=cuda` is kept as a runner/check signal, not as a forced model-load argument.

```bash
uv python install 3.11
uv venv "$HOME/.venvs/voice-lab-voxcpm" --python 3.11
source "$HOME/.venvs/voice-lab-voxcpm/bin/activate"
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_DEVICE=cuda npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

The runtime check prints Python version, service imports, Torch CUDA/MPS availability, CUDA device count and device names, `VOXCPM_MODEL`, and the requested `VOXCPM_DEVICE`. It does not print bearer tokens, transcripts, audio paths, or base64 audio.

## Docker CUDA

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

Point the Next app at `http://127.0.0.1:8809`.

## Health Checks

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

The health check verifies service/auth wiring. It does not load VoxCPM2, does not require CUDA, and does not run generation.

## Runtime Behavior

- `/health` verifies service/auth wiring and reports whether the model is already loaded.
- The VoxCPM2 model loads lazily on the first `/generate` request.
- First generation may take time while model weights load.
- The Python service returns WAV audio.
- The Next app writes WAV intermediates, merges/levels them, and masters the final MP3.
- VoxCPM2 uses reference-based cloning. Voice Lab does not fine-tune, train, or persist a custom voice model.

## Normal Narration Workflow

1. Run `npm run local`.
2. Open [http://localhost:3000](http://localhost:3000).
3. Paste source text.
4. Choose a file name and mastering preset.
5. Generate MP3 and download the mastered result.

Voice Lab automatically reuses the saved local reference. The reference controls stay behind Voice settings after a voice is configured.

## One-Time Reference Setup

Create the reference once through Voice settings:

1. Record in the browser or upload a clean 45-90 second reference clip.
2. Paste the exact words spoken in that clip.
3. Save Reference and return to the text-first narration workflow.

Supported reference uploads include MP3, M4A, MP4 audio, WAV, WebM, OGG, and FLAC. The Next app uses ffmpeg to decode/probe the input and writes a reusable canonical mono 48 kHz PCM WAV at `VOICE_LAB_DATA_DIR/references/default/reference.wav`.

Direct local setup is also supported:

```bash
mkdir -p ~/.voice-lab/references/default
cp ~/Desktop/my-voice.m4a ~/.voice-lab/references/default/reference.m4a
cp ~/Desktop/transcript.txt ~/.voice-lab/references/default/transcript.txt
npm run reference:prepare
npm run local
```

The exact transcript matters. Mismatched words, background noise, clipping, and inconsistent microphone distance can degrade the result. Reference audio, transcripts, and metadata belong in `VOICE_LAB_DATA_DIR`, not in the repository.

## Security

- Do not expose the service without authentication.
- Prefer localhost, SSH tunnels, private networks, or authenticated HTTPS.
- Use a strong `VOXCPM_API_KEY`.
- Do not log base64 audio payloads, transcripts, source text, or bearer tokens.
- Keep reference audio and generated runs in `VOICE_LAB_DATA_DIR`, outside the repo.

## Known Unverified Items

- End-to-end CUDA generation speed and quality.
- End-to-end Apple Silicon MPS generation behavior.
- Long-form multi-section stability on both hardware paths.
- Denoiser behavior with `VOXCPM_LOAD_DENOISER=true`.
