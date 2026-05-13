# Pre-Merge Quality Control Checklist

Run these checks before merging any worktree branch that touches `ui/` files.

## Automated Checks (required)

```bash
# 1. Build passes
npm run build

# 2. UI element references are valid (no JS refs to non-existent HTML IDs)
npx tsx test/ui-element-refs.test.ts

# 3. End-to-end validation (if time allows — 3-5 min)
npm run build && npx tsx test/validate.ts
```

## Docker Checks (required if Dockerfile / compose / workflow changed)

```bash
# 1. Image builds cleanly
docker build -t vibespot:dev .

# 2. Container boots and /healthz responds within 30s
docker run -d --name vibespot-qc -p 4200:4200 vibespot:dev
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:4200/healthz && break || sleep 1
done

# 3. Bundled assets resolve inside the image
curl -fsS http://127.0.0.1:4200/api/starters | jq '.starters | length'   # must be >= 5

docker rm -f vibespot-qc
```

The `.github/workflows/docker-image.yml` CI job runs the same smoke test on
every push, so a green CI run is acceptable in place of a local repro.

## Manual Checks (required for HTML/JS restructuring)

- [ ] Every `getElementById("x")` in ui/*.js either targets an ID in `ui/index.html` or a dynamically-created element
- [ ] Every `getElementById` used directly (`.method()`) without `?.` targets an ID that exists in the static HTML
- [ ] All `<script src="...">` tags in `index.html` reference files that exist in `ui/`
- [ ] Start the dev server (`npm run dev`) and verify:
  - [ ] Setup screen loads without console errors
  - [ ] Creating/opening a project transitions to editor without errors
  - [ ] Settings tab opens and renders
  - [ ] Browser console shows 0 TypeErrors

## When to Run

- **Always**: `npm run build` + `npx tsx test/ui-element-refs.test.ts`
- **After HTML restructuring**: Full manual checklist above
- **Before milestone tag**: Full checklist + `test/validate.ts`
