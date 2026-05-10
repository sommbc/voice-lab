# Voice Lab

Voice Lab is a local-first, open-source app for VoxCPM2 voice cloning: record or upload reference audio, enter the exact reference transcript, paste long-form text, generate VoxCPM2 narration, and export one mastered MP3.

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

- Voice Lab does not switch between hosted speech services.
- Voice Lab does not include hosted deployment, user accounts, billing, or public storage.
- Voice Lab does not guarantee perfect voice cloning or seamless long-form continuity.
- Voice Lab does not hide the need for suitable GPU hardware for practical VoxCPM2 generation.

## Requirements

- Node.js `>=20.9.0`
- npm
- ffmpeg, from `ffmpeg-static` or available on `PATH`
- A running VoxCPM2 service, locally or on a private GPU endpoint
- CUDA GPU strongly recommended for real generation work

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The Next app needs a VoxCPM2 service before generation works. You can run it on the same machine, on a private GPU box, or behind an SSH tunnel.

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VOICE_LAB_DATA_DIR` | No | `~/.voice-lab` | Private local storage root for references, run artifacts, and final audio. Keep this outside the repo. |
| `VOICE_LAB_MASTERING_STRATEGY` | No | `static` | `static` or `speech-leveler`. |
| `VOXCPM_ENABLED` | Yes | `false` | Must be `true` for generation. |
| `VOXCPM_ENDPOINT_URL` | Yes | `http://127.0.0.1:8809/generate` | Authenticated VoxCPM2 generation endpoint. |
| `VOXCPM_HEALTH_URL` | No | `http://127.0.0.1:8809/health` | Authenticated health endpoint for manual checks. |
| `VOXCPM_API_KEY` | Yes | none | Shared bearer token between the Next app and the VoxCPM2 service. |
| `VOXCPM_ENDPOINT_MODE` | No | `native-wrapper` | Use `native-wrapper` for `services/voxcpm/server.py`; `vllm-omni` is available for compatible private endpoints. |
| `VOXCPM_MODEL` | No | `openbmb/VoxCPM2` | Model identifier used by the service or compatible endpoint. |
| `VOXCPM_TIMEOUT_MS` | No | `300000` | Request timeout for generation. |
| `VOXCPM_CFG_VALUE` | No | `2.0` | VoxCPM2 CFG value. |
| `VOXCPM_INFERENCE_TIMESTEPS` | No | `10` | VoxCPM2 inference steps. |
| `VOXCPM_NORMALIZE_TEXT` | No | `true` | Sends the normalize flag to the VoxCPM2 service. |
| `VOXCPM_DENOISE_REFERENCE` | No | `false` | Requests denoising when the service was started with denoiser support. |

Example `.env.local`:

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

## Running The Next App

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app stores private artifacts under `VOICE_LAB_DATA_DIR`, not inside the repo, unless you intentionally point it there.

## Running The VoxCPM2 Service

The native wrapper lives in `services/voxcpm/server.py` and exposes authenticated `/health` and `/generate` endpoints.

```bash
uv python install 3.11
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
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

Private GPU or RunPod pattern:

```bash
ssh -N -L 8809:127.0.0.1:8809 root@<gpu-host>
```

Health check:

```bash
curl -H "Authorization: Bearer $VOXCPM_API_KEY" http://127.0.0.1:8809/health
```

Do not expose the service without authentication. Prefer localhost, SSH tunnels, private networks, or authenticated HTTPS.

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

Longer text is chunked for VoxCPM2, generated as WAV sections, leveled, merged, mastered, and returned as one MP3.

## Storage And Privacy

- `VOICE_LAB_DATA_DIR` defaults to `~/.voice-lab`.
- Reference audio and exact transcripts are private local files.
- Generated WAVs, MP3s, and manifests can contain private material.
- Manifests store hashes, filenames, metrics, and run metadata instead of raw source text.
- `.env.local`, common audio formats, local storage folders, build folders, and temp artifacts are ignored by git.
- Do not deploy this publicly without adding authentication, upload limits, retention controls, and a storage policy.

See [docs/privacy.md](docs/privacy.md).

## Troubleshooting

- `VoxCPM2 is disabled`: set `VOXCPM_ENABLED=true` in `.env.local`.
- `Missing required env var: VOXCPM_API_KEY`: set the same bearer token in the Next app and the FastAPI service.
- `Unauthorized`: confirm the service received `Authorization: Bearer <VOXCPM_API_KEY>`.
- Empty or very short reference transcript: paste the exact spoken words from the reference clip.
- Slow generation: use a CUDA GPU and keep the service close to the Next app network-wise.
- ffmpeg errors: confirm `ffmpeg-static` installed successfully or install ffmpeg on `PATH`.
- Poor voice similarity: try a cleaner reference clip, better transcript alignment, and consistent microphone distance.

## Scripts

```bash
npm run dev
npm test
npm run typecheck
npm run build
npm run check
npm run clean
npm run analyze-audio -- ./path/to/file.mp3
```

`npm run check` runs tests, TypeScript, and production build. There is no lint script until a real lint configuration exists.

## Limitations

- VoxCPM2 generation quality depends on model behavior, reference quality, text length, and GPU performance.
- Long-form continuity is assisted by chunk prompting and leveling, but final listening review is still required.
- The app streams generated audio back to the browser as base64, which is appropriate for trusted local use but not hardened public delivery.
- CPU-only generation is not expected to be practical for long-form work.

## Attribution

Voice Lab builds on meaningful open-source work, including:

- OpenBMB VoxCPM / VoxCPM2
- FFmpeg
- Next.js
- React
- FastAPI
- soundfile

Voice Lab is not affiliated with or endorsed by these projects unless stated otherwise.

## License

MIT. See [LICENSE](LICENSE).
