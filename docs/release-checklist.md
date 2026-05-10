# Release Checklist

Use this before publishing or tagging a public release.

## Repo Hygiene

- `git status --short` is clean before starting release work.
- `.env`, local storage, generated audio, debug artifacts, `.next`, `.vercel`, `.DS_Store`, and `tsconfig.tsbuildinfo` are absent from the commit.
- `.env.example` contains placeholders only.
- No private absolute paths, personal voice IDs, private transcripts, or generated audio fixtures are tracked.
- README and docs describe current behavior honestly.

## Verification

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
```

If scripts change, also run:

```bash
npm run check
```

## Security

- Provider keys are server-only.
- VoxCPM2 requires bearer auth.
- Public deployments have an explicit auth and retention plan.
- Debug artifacts are disabled by default.
- Generated manifests do not contain raw transcript text or private paths.

## Manual Audio Review

- Test at least one short Mistral run.
- Test one forced segmented Mistral run when credentials are available.
- Test one VoxCPM2 run only in a private GPU environment.
- Listen to joins and final mastered MP3 before presenting quality claims.
