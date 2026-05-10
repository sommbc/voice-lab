# Architecture

Voice Lab is split between a local Next.js app, shared TypeScript audio/text utilities, private filesystem storage, and a separate authenticated VoxCPM2 FastAPI service.

## Runtime Diagram

```text
Browser
  -> Next.js UI
  -> Next.js API routes
  -> FastAPI VoxCPM2 service
  -> VoxCPM2 model runtime
  -> WAV section output
  -> Node/ffmpeg standardize, level, merge, master
  -> MP3 response

Storage:
  VOICE_LAB_DATA_DIR, outside the repository
```

There is no hosted speech inference in the default architecture. The Next app calls only the configured private VoxCPM2 endpoint.

## Boundaries

- Browser: submits long-form source text, receives the final MP3, and only captures/uploads reference audio plus exact transcript text during one-time voice setup.
- Next.js API: validates requests, loads saved reference metadata, cleans and chunks text, calls VoxCPM2, writes WAV intermediates, masters MP3 output, and returns progress events.
- FastAPI VoxCPM2 service: owns Python, PyTorch, VoxCPM, model loading, and WAV generation.
- Filesystem storage: stores references, transcripts, run workspaces, WAV intermediates, final MP3s, and sanitized manifests under `VOICE_LAB_DATA_DIR`.

The Next app never imports Torch, VoxCPM, or Python packages.

## Important Paths

- `app/page.tsx`: text-first narration UI for source text, output settings, progress, MP3 download, and collapsed voice settings.
- `app/api/generate/route.ts`: VoxCPM2 long-form generation, WAV intermediates, merging, mastering, and response streaming.
- `app/api/voice-references/route.ts`: reference audio/transcript upload route.
- `lib/voxcpm.ts`: VoxCPM2 HTTP client, payload builder, and environment parsing.
- `lib/voxcpm-generation.ts`: chunk sizing and prompt plan logic.
- `lib/storage.ts`: private storage root and path safety helpers.
- `lib/voice-reference-store.ts`: reference metadata, transcript validation, upload normalization, and run workspace creation.
- `lib/text.ts`: source cleanup, paragraph preservation, and segmentation.
- `lib/audio.ts`: mastering, measurement, seam diagnostics, merging, and audio utility functions.
- `services/voxcpm/`: authenticated VoxCPM2 service and runtime checks.

## Generation Flow

1. Load the saved reference audio and exact transcript from `VOICE_LAB_DATA_DIR`.
2. Clean and segment target text.
3. Build a VoxCPM2 prompt plan from the reference transcript and previous generated sections.
4. Call the authenticated VoxCPM2 service for each section.
5. Store raw WAV output, standardize it, level it, merge sections, and master the final file.
6. Persist a sanitized manifest with hashes, filenames, metrics, settings, and run metadata.
7. Return one MP3 to the browser.

## Storage Model

`VOICE_LAB_DATA_DIR` defaults to `~/.voice-lab`. Storage helpers resolve paths under that root and reject path traversal. Manifests should store filenames, hashes, metrics, settings, and run IDs, not raw transcript text, source text, base64 audio, bearer tokens, or private absolute paths.

The repository ignores local fallback folders such as `runs/`, `voice-references/`, `.voice-lab/`, `output/`, common audio extensions, temp folders, and model-cache folders.

## Security Model

The VoxCPM2 service requires bearer auth for `/health` and `/generate`. Bind it to localhost, a private network, an SSH tunnel, or authenticated HTTPS. Do not log full audio payloads, bearer tokens, reference transcripts, generated text, or private paths.
