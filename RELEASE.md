# Releasing vibeSpot

The canonical release runbook. **Every release updates the four "what changed" surfaces, then builds, tags, and publishes.** No feature ships to users without being reflected in all four — if a feature isn't in the CHANGELOG and the docs, it isn't released.

This exists so nobody has to remember the doc step by hand. The order below is the order to do it in.

---

## 0. Gather what shipped

The source list is every change merged since the last tag:

```bash
git fetch --tags
git log "$(git describe --tags --abbrev=0)"..origin/main --oneline
```

Each user-facing entry (every `VIB-xxxx`) must end up in the CHANGELOG and, if it changes what a user sees or does, in the README and `ui/docs`.

## 1. Bump the version

Set the new semver in `package.json` (`version`). This single value drives the git tag, the npm release, and which CHANGELOG section the "What's new" modal shows.

## 2. Update the four content surfaces — REQUIRED, every release

| # | Surface | What to do |
|---|---------|-----------|
| 1 | **`CHANGELOG.md`** | Add a `## <version> — <YYYY-MM-DD>` section. Write each highlight as `- **Bold user-facing title** ([VIB-xxxx](/VIB/issues/VIB-xxxx)) — what it does for the user.` The **bold title and the body are what the "What's new" modal shows verbatim**, so write them as highlights a user would care about, not internal notes. |
| 2 | **`README.md`** | Update the "What's new" list and any tour / feature / command / setup section the release touches. |
| 3 | **`ui/docs/index.html`** | Document every new feature or changed workflow — add or extend a section **and** its nav link. This is the in-app documentation users actually read. |
| 4 | **The "What's new" modal** | Runs from the CHANGELOG automatically — `npm run whatsnew:gen` (part of `npm run build`) regenerates `assets/whats-new.json` from the section you wrote in step 1. **Writing good CHANGELOG bullets *is* authoring the modal.** Verify after building (step 3 below). |

Also update **`CLAUDE.md`** when architecture, constraints, or key behaviours changed (it's the map every agent reads — keep it true).

> **The check that catches lag:** for each `VIB-xxxx` since the last tag, confirm it appears in the CHANGELOG and — if user-facing — in `ui/docs` and the README. A feature that's in the code but not the docs is the default failure mode; this step is here to catch it. (Example: barge-in / queue-by-default shipped in code well before it reached `ui/docs`.)

## 3. Build & verify

```bash
npm run build                       # regenerates assets/whats-new.json + bundles dist
npx tsc --noEmit                    # types clean
npm test                            # vitest
npx tsx test/ui-element-refs.test.ts  # UI id references (run after any ui/*.js or index.html change)
```

Then confirm the modal content matches the release:

```bash
cat assets/whats-new.json   # version === package.json version, highlights are the real, user-facing bullets
```

For a heavier check, the end-to-end validation (`npx tsx test/validate.ts`, ~3–5 min, needs HubSpot creds) is local-only.

## 4. Tag, release, publish

1. Commit the version bump + doc updates; open a PR; merge to `main` (branch-protected — Boris merges, or `--admin` on his explicit go).
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. Cut the GitHub release — notes = the CHANGELOG section.
4. `npm publish` — **Boris** (the agent token hits `ENEEDAUTH`).
5. Docker image: `npm run docker:publish` — see [`docs/docker.md`](docs/docker.md). (May need `write:packages` on the agent's `gh` token; Boris grants it.)

## The rule (one line)

**Bump the version, write the CHANGELOG, mirror it into README + `ui/docs`, build (which regenerates the modal), verify, tag, publish.** The first four are not optional and not "later" — they are part of the same change as the code.

---

See also: `CLAUDE.md` → **Release Checklist**, and the `release` skill in `.claude/skills/release/` (same procedure, surfaced automatically when you're cutting a release).
