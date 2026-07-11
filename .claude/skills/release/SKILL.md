---
name: release
description: Cut a vibeSpot release the complete way — bump the version and update ALL four "what changed" surfaces (CHANGELOG.md, README.md, ui/docs/index.html, and the "What's new" modal via assets/whats-new.json), then build, verify, tag, and publish. Use whenever preparing, cutting, or shipping a vibeSpot release, bumping the version for publish, or when asked to "release", "ship a version", "publish to npm", or update the changelog/docs for a release. The point is that the docs and modal are never forgotten — they are part of the release, not an afterthought.
---

# release

The full vibeSpot release procedure. The canonical, detailed runbook is [`RELEASE.md`](../../../RELEASE.md) at the repo root — read it. This skill is the short, enforced version so the doc step is never skipped.

## Why this exists

The recurring failure is shipping code while the docs and the in-app "What's new" modal lag behind. Every release MUST update four surfaces. Treat them as part of the same change as the code, not a follow-up.

## The four surfaces (REQUIRED every release)

1. **`CHANGELOG.md`** — add `## <version> — <YYYY-MM-DD>`. Each bullet: `- **Bold user-facing title** ([VIB-xxxx](/VIB/issues/VIB-xxxx)) — what it does.` The bold title + body are shown **verbatim in the "What's new" modal**, so write them for a user, not as internal notes.
2. **`README.md`** — "What's new" list + any tour/feature/command/setup section the release touches.
3. **`ui/docs/index.html`** — document every new feature / changed workflow (section **and** nav link). In-app docs.
4. **The "What's new" modal** — regenerated from the CHANGELOG by `npm run whatsnew:gen` (inside `npm run build`) → `assets/whats-new.json`. Writing the CHANGELOG *is* authoring the modal. Verify it after building.

Update **`CLAUDE.md`** too when architecture / constraints / key behaviours changed.

## Procedure

1. **List what shipped:** `git log "$(git describe --tags --abbrev=0)"..origin/main --oneline`. Every `VIB-xxxx` must land in the CHANGELOG and — if user-facing — in README + `ui/docs`.
2. **Bump** `package.json` `version`.
3. **Write the four surfaces** (table above).
4. **Build & verify:**
   ```bash
   npm run build
   npx tsc --noEmit && npm test && npx tsx test/ui-element-refs.test.ts
   cat assets/whats-new.json   # version === package.json, real user-facing highlights
   ```
5. **Audit for lag:** for each shipped `VIB-xxxx`, confirm it's documented. The build-time `whatsnew:gen` only handles the modal — README and `ui/docs` are on you.
6. **Tag & publish:** PR → merge to `main`; `git tag v<version> && git push origin v<version>`; cut the GitHub release (notes = CHANGELOG section); `npm publish` (Boris — agent token is `ENEEDAUTH`); `npm run docker:publish` (see `docs/docker.md`).

## The rule

Bump version → write CHANGELOG → mirror into README + `ui/docs` → build (regenerates the modal) → verify → tag → publish. The first four are not optional and not "later".
