# Contributing

Voice Lab is intended to stay useful as a local-first VoxCPM2 voice cloning app, not a pile of speech experiments.

## Development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Before opening a pull request:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

`npm run check` runs the same test, typecheck, and build sequence.

## Expectations

- Keep the public product focused on VoxCPM2 voice cloning to mastered MP3 narration.
- Do not commit generated audio, reference clips, exact transcripts, local runs, or debug artifacts.
- Keep the Python model runtime outside the Next app.
- Keep bearer tokens server-side.
- Do not claim perfect cloning or seamless long-form quality without reproducible evidence.
- Prefer narrow changes over broad rewrites unless the architecture clearly needs it.
- Update README or docs when behavior, setup, environment variables, or the workflow changes.

## Issues And Pull Requests

For bugs, include the VoxCPM2 endpoint mode, Node version, operating system, relevant env var names without values, and the smallest input that reproduces the issue.

For audio-quality issues, include objective diagnostics when possible: generation mode, segment count, mastering preset, and whether the issue appears before or after final mastering.
