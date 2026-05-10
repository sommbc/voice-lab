# Release Checklist

Use this before publishing or tagging a public release.

## Repo Hygiene

- `git status --short` is clean before starting release work.
- `.env`, local storage, generated audio, debug artifacts, `.next`, `.vercel`, `.DS_Store`, and `tsconfig.tsbuildinfo` are absent from the commit.
- `.env.example` contains placeholders only.
- No private absolute paths, personal voice IDs, private transcripts, or generated audio fixtures are tracked.
- README and docs describe only the current VoxCPM2 workflow.

## Residue Checks

Search the repo for old hosted-service names, private domains, personal identifiers, private paths, generated audio, generated manifests, and local build output. Expected result: no public-surface matches, except ignore rules for local artifact folders.

## Verification

```bash
npm test
npx tsc --noEmit
npm run build
npm run check
git diff --check
python3 -m py_compile services/voxcpm/server.py
```

If the VoxCPM2 service can start without loading the full model, also verify authenticated `/health` succeeds and unauthenticated `/health` returns `401`.

## Security

- VoxCPM2 requires bearer auth.
- The service is bound to localhost, a private network, an SSH tunnel, or authenticated HTTPS.
- Public deployments have an explicit auth and retention plan.
- Generated manifests do not contain raw transcript text or private paths.

## Manual Audio Review

- Test one short VoxCPM2 reference generation in a private GPU environment.
- Test one long-form VoxCPM2 run with multiple sections.
- Listen to joins and final mastered MP3 before making quality claims.
