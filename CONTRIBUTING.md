# Contributing

Voice Lab is intended to stay useful as a local-first speech lab, not a pile of provider demos.

## Development

```bash
npm install
cp .env.example .env
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

- Keep provider secrets server-side.
- Do not commit generated audio, reference clips, exact transcripts, local runs, or debug artifacts.
- Keep provider adapters small and test payload construction without network calls.
- Do not claim perfect cloning or seamless long-form quality without reproducible evidence.
- Prefer narrow changes over broad rewrites unless the architecture clearly needs it.
- Update README or docs when behavior, setup, environment variables, or provider support changes.

## Issues And Pull Requests

For bugs, include the provider, model or endpoint mode, Node version, operating system, relevant env var names without values, and the smallest input that reproduces the issue.

For audio-quality issues, include objective diagnostics when possible: provider, generation mode, segment count, mastering preset, and whether the issue appears before or after final mastering.
