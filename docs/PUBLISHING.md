# Publishing GhostGlass

Everything below is a **human-owner action**. Nothing here should be done
by automation: each step involves an identity, an account, or a release
decision only the owner can make.

## Blockers (must resolve before the repo goes public)

1. **GitHub username / organization.** RESOLVED — the repository is
   `solhopie/ghostglass`; `README.md` now uses the real clone URL.
2. **Git author identity.** Past commits (Runs 1–9) are authored as
   `Zipper <zipper@localhost>`. Decide whether to keep that history as-is
   or rewrite author identities before the first push. History must not be
   rewritten after publishing.
3. **License attribution.** `LICENSE` reads
   `Copyright (c) 2026 GhostGlass contributors`. If a real name or
   organization should hold copyright, set it before publishing.
4. **`package.json` metadata.** `repository`, `bugs`, and `homepage`
   fields are intentionally absent (no URL invented). Fill them in once
   the GitHub repo exists.

## Publication steps

1. Create the GitHub repository (public or private-for-now). — DONE:
   `solhopie/ghostglass`, public.
2. `git remote add origin <repo-url>` in this checkout. — DONE.
3. Fill `repository` / `bugs` / `homepage` in `package.json`.
4. Enable **private vulnerability reporting** (Settings → Security →
   "Private vulnerability reporting") — `SECURITY.md` already points
   reporters there.
5. `git push -u origin main`.
6. Decide the release version. The working version is `0.9.0`; `v0.4.0`
   is the only tag and must stay untouched. Do not create a `v0.9.0` tag
   unless that is the intended release — tag only the version you mean
   to release.
7. Push the release tag (`git push origin <tag>`), if any.
8. Watch the first **GitHub Actions CI** run on `main` and confirm it is
   green. (The workflow is `.github/workflows/ci.yml`; it has never run
   on GitHub-hosted runners yet.)
9. Record a real Live Glass session and save it as
    `docs/assets/live-glass.png`. The managed browser in this build
    environment cannot reach the VM's localhost, so this needs a human
    with a local browser: `ghostglass watch -- node test/fixtures/live-demo-long.cjs`,
    screenshot mid-stream, trim to a reasonable file size.
10. `docs/assets/behavior-highlights.png` is already captured (referenced by
    `README.md`); replace it only if the highlights UI changes materially.
12. If publishing to npm: `npm publish` (from a clean checkout, after
    `npm pack` review). Until then, `npm install -g ghostglass` remains
    documented as "available after the npm package is published."

## After publishing

- `README.md` Quick Start: replace the placeholder clone URL (blocker 1).
- Update the `npm:` note once the package is actually on npm.
- Consider a `v1.0.0` release cut only after the demo recording,
  screenshots, and a green CI run are all in place — see
  `docs/releases/preview.md`.
