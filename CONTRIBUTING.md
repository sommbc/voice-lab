# Contributing

Voice Lab is intended to stay focused: local-first VoxCPM2 voice cloning for long-form narration and mastered MP3 export.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

The Next app can run without the Python service, but generation requires a private VoxCPM2 service and `VOXCPM_ENABLED=true`.

For service setup, see [docs/voxcpm.md](docs/voxcpm.md).

## Checks

Run the relevant checks before opening a pull request:

```bash
npm test
npx tsc --noEmit
npm run build
npm run check
npm run test:voxcpm
python3 -m py_compile services/voxcpm/server.py
python3 -m py_compile services/voxcpm/check_runtime.py
python3 -m py_compile services/voxcpm/check_health.py
git diff --check
```

`npm run check:voxcpm` verifies imports and hardware visibility when Python dependencies are installed. It does not run generation. Do not claim runtime support from import checks alone.

## Branches And Pull Requests

- Keep pull requests narrow and explain the behavior being changed.
- Include the checks you ran and the exact result.
- Update README or docs when setup, environment variables, runtime behavior, or workflow changes.
- Do not mix product changes with unrelated repo cleanup.
- Do not add generated screenshots, audio, transcripts, run manifests, model caches, or build output.

## Coding Style

- Reuse existing TypeScript and Python patterns before adding helpers.
- Keep the Python model runtime outside the Next app.
- Keep bearer tokens server-side.
- Prefer explicit validation and safe error messages over leaking private paths, transcripts, payloads, or tokens.
- Avoid provider switching, hosted inference integrations, speech-to-text, or public deployment assumptions unless the project scope changes explicitly.

## Runtime Issue Reports

For VoxCPM2 runtime issues, include:

- Operating system and hardware.
- Python version.
- PyTorch version and whether CUDA or MPS is detected.
- `VOXCPM_DEVICE`, `VOXCPM_MODEL`, and endpoint mode, without secret values.
- The output of `npm run check:voxcpm` with secrets and private paths removed if needed.
- Whether `/health` passes with `npm run check:voxcpm:health`.
- Whether the failure happened before model load, during generation, or during final audio processing.

For audio-quality issues, include objective diagnostics when possible: segment count, mastering preset, whether the issue appears in WAV intermediates or only in the final MP3, and a non-private reproduction if available.
