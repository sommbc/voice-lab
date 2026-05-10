# Voiceover

Private tool for converting pasted long-form text into one narration file. Mistral Voxtral remains the default provider. VoxCPM2 is available as an opt-in local/CUDA voice-cloning provider that saves Brandon reference material outside the repo and exports final MP3 files through the existing mastering path.

## Current behavior

- Continuous Read is the default path for long-form essays.
- The app cleans the full document, sends one Mistral TTS request first, then applies final mastering to the completed file before delivery.
- If the full-document request fails for a chunking-worthy reason, the app falls back to deterministic segmented generation: smaller Mistral-safe chunks, continuity context for each TTS request, WAV standardization, per-segment static loudness leveling, bounded fade-down correction, adaptive join pauses, mechanical and tonal seam scoring, selective bad-seam regeneration, optional multi-take seam optimization, boundary repair when a seam still sounds like a new take, boundary-aware edge matching, WAV merge, publishability verdicting, and gentle final mastering.
- The default delivery preset is Substack-ready MP3: Normal volume, `-16 LUFS` integrated loudness, `-1.5 dBTP` true peak, 24 kHz mono WAV intermediates, and `192k` MP3 export.
- Advanced controls can force segmented generation directly when needed.
- VoxCPM2 runs as a separate authenticated FastAPI service. The Next.js app calls it over HTTP only and never imports Torch or VoxCPM.
- VoxCPM2 reference audio, exact transcript, run WAVs, final MP3s, and manifests live under `VOICEOVER_DATA_DIR` outside the repo, defaulting to `/Users/bcarneiro/.voiceover`.

## Running locally

```
npm install
npm run dev
```

Requires Node.js 18+. The server uses `ffmpeg` for narration normalization and multi-segment merges; it will use the bundled binary when available and fall back to a system `ffmpeg` on PATH.

## Tests

```
npm test
npx tsc --noEmit
npm run build
npm run analyze-audio -- ./path/to/file.mp3
npm run segmented-ab -- ./path/to/long-form-essay.md
```

## Environment variables

```
MISTRAL_API_KEY
MISTRAL_VOICE_ID
VOICEOVER_DATA_DIR
VOICEOVER_DEBUG_AUDIO
VOICEOVER_MASTERING_STRATEGY
VOICEOVER_CONTEXT_OVERLAP
VOICEOVER_TONE_SEAM_SCORING
VOICEOVER_SEAM_RETRIES
VOICEOVER_MULTI_TAKE_COUNT
VOXCPM_ENABLED
VOXCPM_ENDPOINT_URL
VOXCPM_HEALTH_URL
VOXCPM_API_KEY
VOXCPM_ENDPOINT_MODE
VOXCPM_MODEL
VOXCPM_TIMEOUT_MS
VOXCPM_CFG_VALUE
VOXCPM_INFERENCE_TIMESTEPS
VOXCPM_NORMALIZE_TEXT
VOXCPM_DENOISE_REFERENCE
```

`MISTRAL_API_KEY` and `MISTRAL_VOICE_ID` are required.

Optional server-only audio diagnostics:

- `VOICEOVER_DEBUG_AUDIO=true` keeps raw, standardized, leveled, merged pre-master, final, seam-clip, and manifest debug artifacts under `/tmp` and logs file references server-side only.
- `VOICEOVER_REGENERATE_BAD_SEAMS=false` disables the default bounded bad-seam retry pass for segmented generation.
- `VOICEOVER_CONTEXT_OVERLAP=false` disables the default continuity prompt context used in segmented generation.
- `VOICEOVER_TONE_SEAM_SCORING=false` disables the default prosody/tone seam proxy scoring.
- `VOICEOVER_SEAM_RETRIES=2` controls how many bounded regeneration passes are attempted for failed seams.
- `VOICEOVER_MULTI_TAKE_COUNT=1` is the default segmented path. Set `2` or `3` for expensive multi-take seam optimization; values above `5` are clamped.
- `VOICEOVER_MASTERING_STRATEGY=static` keeps the current static chain as the default.
- `VOICEOVER_MASTERING_STRATEGY=speech-leveler` enables the speech-leveler mastering experiment.

## VoxCPM2 service

VoxCPM2 v1 uses `services/voxcpm/server.py` as the native FastAPI service. Use CUDA for real work; local Mac MPS is only a smoke-test path.

CUDA setup:

```
uv python install 3.11
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

Docker / RunPod:

```
docker build -f services/voxcpm/Dockerfile -t voiceover-voxcpm2:cuda .
docker run --gpus all --rm \
  -p 127.0.0.1:8809:8809 \
  -e VOXCPM_API_KEY="$VOXCPM_API_KEY" \
  -e VOXCPM_MODEL="openbmb/VoxCPM2" \
  -e VOXCPM_DEVICE="cuda" \
  voiceover-voxcpm2:cuda
```

RunPod/private endpoint:

```
ssh -N -L 8809:127.0.0.1:8809 root@<runpod-host>
```

Health check:

```
curl -H "Authorization: Bearer $VOXCPM_API_KEY" http://127.0.0.1:8809/health
```

Never expose the VoxCPM2 service as an unauthenticated public endpoint. Bind locally, use an SSH tunnel/private network, or place authenticated HTTPS in front of it.

## Private artifact rules

Do not commit reference WAVs, transcripts, generated MP3/WAV files, or manifests containing transcript text or unsanitized private paths. Repo fallback artifact paths are ignored, but the intended storage location is still `VOICEOVER_DATA_DIR` outside the repo.
