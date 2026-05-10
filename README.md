# Voice Lab

Voice Lab is a local-first VoxCPM2 voice cloning app for long-form narration and mastered MP3 export.

## Project Status

Voice Lab is an early release. The Next.js app, FastAPI service wrapper, storage layer, audio pipeline, and non-generation checks are built. Live VoxCPM2 generation depends on your local Python, PyTorch, model cache, and device setup.

Voice Lab is local-first and self-hosted. The app does not use hosted speech inference. VoxCPM2 model runtime depends on your Python/PyTorch/device setup. CUDA is expected to be fastest. Apple Silicon MPS may work but still needs validation for long-form workloads.

Current validation status:

- App tests, TypeScript, production build, Python service unit tests, and Python syntax checks pass in this repo.
- Service import and health-check scripts are included for target Python/runtime environments.
- Live VoxCPM2 generation is not yet fully proven across supported hardware.
- Apple Silicon MPS still needs long-form validation.
- CUDA/Linux still needs end-to-end runtime validation on real GPU hardware.

## Features

- VoxCPM2 reference-voice generation through an authenticated FastAPI service.
- Browser recording or audio upload for the reference clip.
- Exact transcript storage for reference prompting.
- Long-form text cleanup, paragraph preservation, and chunk planning.
- Previous-section prompting for longer narration continuity.
- WAV intermediates for generation, standardization, leveling, and merging.
- Final mastering to MP3 with normal, louder, and very-loud presets.
- Private local storage for references, generated audio, and sanitized run manifests.
- Audio analysis utility for inspecting generated files.

## What It Does Not Do

- It does not use hosted speech inference.
- It does not include speech-to-text.
- It does not add provider switching or fallback TTS services.
- It does not include hosted deployment, user accounts, billing, or public storage.
- It does not guarantee perfect cloning or seamless long-form continuity.
- It does not hide the need for suitable hardware for practical VoxCPM2 generation.

## Architecture

```text
Browser UI
  -> Next.js app/API
  -> authenticated FastAPI VoxCPM2 service
  -> local VoxCPM2 model runtime
  -> WAV section output
  -> Node/ffmpeg processing
  -> mastered MP3

Private storage:
  VOICE_LAB_DATA_DIR, outside the repository
```

The Next app never imports Torch or VoxCPM. Python model code stays in `services/voxcpm/` and is called over authenticated HTTP.

## Screenshots

Screenshots are intentionally not checked in yet. Add real screenshots only after the public UI and runtime path have been validated; do not add mockups or generated placeholders.

See [docs/screenshots.md](docs/screenshots.md).

## Requirements

- Node.js `>=20.9.0`
- npm
- ffmpeg, from `ffmpeg-static` or available on `PATH`
- Python `3.11` for the VoxCPM2 service
- PyTorch matching your hardware
- VoxCPM2 model weights downloaded through the Hugging Face cache
- CUDA GPU recommended for real generation work

Keep the Python virtual environment outside the repository. A repo-root `.venv` can interfere with the Next/Turbopack build.

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Generation requires a running VoxCPM2 service. The app can start without it, but MP3 generation will fail until `VOXCPM_ENABLED=true`, `VOXCPM_ENDPOINT_URL`, and `VOXCPM_API_KEY` are configured.

## Environment Variables

Copy `.env.example` to `.env.local` and keep `.env.local` private.

| Variable | Required | Default | Scope | Description |
| --- | --- | --- | --- | --- |
| `VOICE_LAB_DATA_DIR` | No | `~/.voice-lab` | Next app | Private storage root for references, run artifacts, and final audio. Keep this outside the repo. |
| `VOICE_LAB_MASTERING_STRATEGY` | No | `static` | Next app | `static` or `speech-leveler`. |
| `VOXCPM_ENABLED` | Yes for generation | `false` | Next app | Must be `true` before the app will call VoxCPM2. |
| `VOXCPM_ENDPOINT_URL` | Yes for generation | `http://127.0.0.1:8809/generate` | Next app | Authenticated generation endpoint. |
| `VOXCPM_HEALTH_URL` | No | `http://127.0.0.1:8809/health` | Checks | Authenticated health endpoint for manual checks. |
| `VOXCPM_API_KEY` | Yes for service and generation | none | Both | Shared bearer token. Never commit a real value. |
| `VOXCPM_ENDPOINT_MODE` | No | `native-wrapper` | Next app | `native-wrapper` for this repo's FastAPI service; `vllm-omni` is only for compatible private endpoints. |
| `VOXCPM_MODEL` | No | `openbmb/VoxCPM2` | Service/checks | Hugging Face model identifier. |
| `VOXCPM_TIMEOUT_MS` | No | `300000` | Next app | Request timeout for generation. |
| `VOXCPM_CFG_VALUE` | No | `2.0` | Next app | VoxCPM2 CFG value sent to the service. |
| `VOXCPM_INFERENCE_TIMESTEPS` | No | `10` | Next app | VoxCPM2 inference steps sent to the service. |
| `VOXCPM_NORMALIZE_TEXT` | No | `true` | Next app | Sends the normalize flag to the service. |
| `VOXCPM_DENOISE_REFERENCE` | No | `false` | Next app/service | Requests denoising. The service must be started with denoiser support. |
| `VOXCPM_DEVICE` | No | auto | Service/checks | `cuda`, `mps`, `cpu`, or unset for VoxCPM auto behavior. |
| `VOXCPM_OPTIMIZE` | No | `true` | Service | Passed to `VoxCPM.from_pretrained`. |
| `HF_TOKEN` | No | none | Service/model download | Optional Hugging Face token for gated or rate-limited downloads. |
| `HF_HOME` | No | Hugging Face default | Service/model download | Optional cache root. Keep it outside the repo. |
| `HF_HUB_CACHE` | No | Hugging Face default | Service/model download | Optional model cache path. Keep it outside the repo. |

Minimal `.env.local` for local service use:

```bash
VOICE_LAB_DATA_DIR="$HOME/.voice-lab"
VOICE_LAB_MASTERING_STRATEGY=static

VOXCPM_ENABLED=true
VOXCPM_ENDPOINT_URL=http://127.0.0.1:8809/generate
VOXCPM_HEALTH_URL=http://127.0.0.1:8809/health
VOXCPM_API_KEY=replace-with-a-strong-local-token
VOXCPM_ENDPOINT_MODE=native-wrapper
VOXCPM_MODEL=openbmb/VoxCPM2
```

## Apple Silicon Setup

Apple Silicon support is not yet proven for long-form workloads. Treat this path as validation work, not a production-quality claim.

```bash
uv python install 3.11
uv venv "$HOME/.venvs/voice-lab-voxcpm" --python 3.11
source "$HOME/.venvs/voice-lab-voxcpm/bin/activate"
uv pip install torch torchaudio
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_DEVICE=mps npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=mps uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

If MPS fails or produces unstable long-form results, use CUDA/Linux for runtime validation.

## CUDA/Linux Setup

CUDA is the expected fastest path for practical VoxCPM2 generation.

```bash
uv python install 3.11
uv venv "$HOME/.venvs/voice-lab-voxcpm" --python 3.11
source "$HOME/.venvs/voice-lab-voxcpm/bin/activate"
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_DEVICE=cuda npm run check:voxcpm
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

Docker:

```bash
docker build -f services/voxcpm/Dockerfile -t voice-lab-voxcpm2:cuda .
docker run --gpus all --rm \
  -p 127.0.0.1:8809:8809 \
  -e VOXCPM_API_KEY="$VOXCPM_API_KEY" \
  -e VOXCPM_MODEL="openbmb/VoxCPM2" \
  -e VOXCPM_DEVICE="cuda" \
  voice-lab-voxcpm2:cuda
```

## Hugging Face Cache

The default model is `openbmb/VoxCPM2`. Voice Lab uses Hugging Face only for model download/cache behavior through the Python runtime. It does not add a hosted Hugging Face inference UI.

For private or rate-limited downloads, set `HF_TOKEN` in your local shell or private service environment. If you set `HF_HOME` or `HF_HUB_CACHE`, point them outside this repository so model weights are never staged by git.

## Running The VoxCPM2 Service

The native wrapper lives in `services/voxcpm/server.py` and exposes authenticated `/health` and `/generate` endpoints.

The service loads the model lazily on the first `/generate` request, not at `/health` startup. First generation can take time while weights load.

```bash
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

Private GPU or RunPod pattern:

```bash
ssh -N -L 8809:127.0.0.1:8809 root@<gpu-host>
```

Do not expose the service without authentication. Prefer localhost, SSH tunnels, private networks, or authenticated HTTPS.

## Running The Next App

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app stores private artifacts under `VOICE_LAB_DATA_DIR`, not inside the repo, unless you intentionally point it there.

## Voice Reference Workflow

1. Record or upload a clean reference clip.
2. Paste the exact words spoken in that clip.
3. Save the reference.
4. Confirm the UI shows a saved reference before generating.

The transcript should match the audio. Background noise, clipping, compression, mismatched words, or shifting microphone distance can reduce voice similarity.

## Generating MP3 Narration

1. Paste long-form text into Source text.
2. Choose a filename and mastering preset.
3. Leave advanced settings alone unless you need reference-audio-only prompting.
4. Generate MP3.
5. Listen to the result before publishing or sharing.

Longer text is chunked for VoxCPM2, generated as WAV sections, leveled, merged, mastered, and returned as one MP3. The Python service returns WAV audio to the Next app. The Next app writes WAV intermediates and produces the final mastered MP3.

## Runtime Checks

```bash
npm test
npx tsc --noEmit
npm run build
npm run check
npm run test:voxcpm
npm run check:voxcpm
VOXCPM_API_KEY="replace-me" npm run check:voxcpm:health
python3 -m py_compile services/voxcpm/server.py
python3 -m py_compile services/voxcpm/check_runtime.py
python3 -m py_compile services/voxcpm/check_health.py
git diff --check
```

`npm run check:voxcpm` checks imports and hardware visibility. It does not run generation. `npm run check:voxcpm:health` expects unauthenticated `/health` to return `401` and authenticated `/health` to return `200`.

## Troubleshooting

- `VoxCPM2 is disabled`: set `VOXCPM_ENABLED=true` in `.env.local`.
- `Missing required env var: VOXCPM_API_KEY`: set the same bearer token in the Next app and FastAPI service.
- `Unauthorized`: confirm the service received `Authorization: Bearer <VOXCPM_API_KEY>`.
- Health check connection failure: start the FastAPI service or confirm the SSH tunnel is active.
- First generation is slow: model weights load lazily on the first `/generate` request.
- Apple Silicon/MPS errors: this path still needs validation for long-form use. Reproduce with `VOXCPM_DEVICE=mps` and report the exact PyTorch/VoxCPM error.
- CUDA not detected: confirm the PyTorch wheel, NVIDIA driver, and container/runtime GPU access match.
- Empty or very short reference transcript: paste the exact spoken words from the reference clip.
- ffmpeg errors: confirm `ffmpeg-static` installed successfully or install ffmpeg on `PATH`.
- Poor voice similarity: try a cleaner reference clip, better transcript alignment, and consistent microphone distance.

## Privacy And Security

- `VOICE_LAB_DATA_DIR` defaults to `~/.voice-lab`.
- Reference audio and exact transcripts are private local files.
- Generated WAVs, MP3s, and manifests can contain private material.
- Manifests store hashes, filenames, metrics, and run metadata instead of raw source text.
- `.env.local`, common audio formats, local storage folders, build folders, and temp artifacts are ignored by git.
- The VoxCPM2 service requires bearer auth. Do not expose it publicly without additional auth, upload limits, rate limits, retention controls, HTTPS, and a storage policy.

See [docs/privacy.md](docs/privacy.md) and [SECURITY.md](SECURITY.md).

## Limitations

- Live VoxCPM2 generation has not yet been proven across Apple Silicon and CUDA setups.
- VoxCPM2 generation quality depends on model behavior, reference quality, text length, and GPU performance.
- Long-form continuity is assisted by chunk prompting and leveling, but final listening review is still required.
- The app streams generated audio back to the browser as base64, which is appropriate for trusted local use but not hardened public delivery.
- CPU-only generation is not expected to be practical for long-form work.

## Roadmap

- Prove short VoxCPM2 generation on CUDA/Linux.
- Prove long-form multi-section generation on CUDA/Linux.
- Validate Apple Silicon MPS behavior and document real limits.
- Add real screenshots after runtime validation.
- Harden public deployment guidance only if the project grows beyond trusted local use.
- Improve audio diagnostics around long-form joins and final mastering.

## Attribution

Voice Lab builds on open-source work, including:

- OpenBMB VoxCPM / VoxCPM2
- FFmpeg
- Next.js
- React
- FastAPI
- soundfile

Voice Lab is not affiliated with or endorsed by these projects unless stated otherwise.

## License

MIT. See [LICENSE](LICENSE).
