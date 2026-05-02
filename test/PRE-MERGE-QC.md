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
