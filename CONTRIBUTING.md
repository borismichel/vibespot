# Contributing to vibeSpot

Thanks for your interest in contributing to vibeSpot. This guide covers setup, workflow, coding standards, and how to build HubSpot CMS modules with the agentic pipeline.

## Getting Started

### Prerequisites

- Node.js 18+
- A HubSpot developer account (for upload testing)

### Setup

```bash
git clone https://github.com/borismichel/vibespot.git
cd vibespot
npm install
npm run dev    # Run in development mode (tsx, no build step)
```

### Build and Test

```bash
npm run build        # Build with tsup -> dist/index.js
node bin/vibespot.mjs # Run the built CLI (requires build first)
```

### Validation

There is no unit test suite yet. After code changes, run:

```bash
npm run build && npx tsx test/validate.ts
```

This end-to-end test clones a real repo, creates a HubSpot theme, runs AI conversion, validates generated files, uploads to HubSpot, verifies, then cleans up. Takes 3-5 minutes. The test is local-only (not in git or npm).

## How to Contribute

### Reporting Bugs

Use the [Bug Report](https://github.com/borismichel/vibespot/issues/new?template=bug_report.yml) template. Include your vibeSpot version, Node.js version, and the AI engine you were using.

### Suggesting Features

Use the [Feature Request](https://github.com/borismichel/vibespot/issues/new?template=feature_request.yml) template. Describe the use case, not just the solution.

### Submitting Code

1. Fork the repository and create a branch from `main`
2. Use a descriptive branch name: `feat/plan-mode`, `fix/reserved-field-names`, `docs/contributing`
3. Fetch and rebase before your first edit (a stale base will revert unrelated work):
   ```bash
   git fetch origin
   git rebase origin/main
   ```
4. Make your changes
5. Run `npm run build` to verify the build succeeds
6. Run the validation test if you changed anything in the pipeline, modules, or upload flow
7. Submit a pull request using the PR template

### What Makes a Good PR

- **Focused on a single change.** One feature or fix per PR. Split refactors into a separate PR.
- **Clear description.** State what changed and why. Link the issue if there is one.
- **Passes the build.** `npm run build` must succeed.
- **Updates documentation** if the change is user-facing (see the docs checklist below).
- **New commits for review feedback.** Don't force-push during review.

### Merge Rules

- Features merge to `main` sequentially. If multiple PRs are ready, each rebases onto the updated `main` before merge.
- After resolving conflicts, re-run validation. A conflict resolution that compiles is not necessarily correct.
- A feature is not done until its code is on `main`.

## Coding Standards

### ESM Only

The project is pure ESM (`"type": "module"` in package.json). No CommonJS `require()`. All internal imports use `.js` extensions:

```typescript
import { resolveAsset } from '../utils/fs.js';
```

### Style

- **No comments by default.** Only add one when the _why_ is non-obvious: a hidden constraint, a workaround, behavior that would surprise a reader.
- **No abstractions beyond what the task requires.** Three similar lines is better than a premature helper.
- **No CDN imports.** All CSS/JS must be self-contained. The pipeline and auto-fix strip external font imports.
- **Module names are kebab-case.** `hero`, `trust-bar`, `pricing-table`. The pipeline enforces this.
- **Keep HubL output compatible** with HubSpot's module format.

### Error Handling

Only validate at system boundaries (user input, external APIs). Trust internal code and framework guarantees. Don't add fallbacks for scenarios that can't happen.

### Brand

When writing user-facing text: `vibeSpot` (lowercase `v`, capital `S`). Never "Vibespot" or "VibeSpot".

## Architecture Overview

The entry flow: `bin/vibespot.mjs` -> `dist/index.js` -> `src/index.ts` -> `src/cli/program.ts` (Commander).

| Directory | Purpose |
|-----------|---------|
| `src/commands/` | One file per CLI command |
| `src/server/` | HTTP server, WebSocket, AI handler, session management |
| `src/server/agent/` | Agentic pipeline (4-stage: intent, architect, developer, validator) |
| `src/server/session/` | Session state, persistence, disk I/O, templates |
| `src/wizard/` | Step implementations for the wizard flow |
| `src/ai/` | AI engine adapters (Anthropic, OpenAI, Gemini, CLI engines) |
| `src/hubl/` | HubL template renderer for local preview |
| `ui/` | Static frontend (HTML, JS, CSS) |
| `assets/` | Bundled guides and plan templates |
| `starters/` | Pre-built starter template bundles |

For full architecture documentation, see `CLAUDE.md`.

## Module Development Guide

vibeSpot generates HubSpot CMS modules. If you're adding or modifying module generation, here's what matters.

### What a Module Contains

Each module lives in `modules/{module-name}/` inside the theme directory:

```
modules/hero/
  fields.json      # Editable fields (text, image, color, etc.)
  module.html      # HubL template
  meta.json        # Module metadata (label, icon, categories)
```

### Module Generation Pipeline

The agentic pipeline in `src/server/agent/` runs four stages:

1. **Intent Analyzer** (`stages/intent-analyzer.ts`) classifies the user request and decides which modules to create, modify, keep, or remove.

2. **Page Architect** (`stages/page-architect.ts`) makes two sequential calls:
   - Design System: creates `:root` CSS variables, shared CSS, shared JS
   - Module Planner: plans module specs (name, description, content brief, layout notes)

3. **Module Developer** (`stages/module-developer.ts`) generates all modules in parallel (up to 20 concurrent). Each module receives the shared CSS, conversion guide, and HubSpot rules as context.

4. **Quality Check** (`stages/validator.ts`) runs rule-based validation and auto-fix:
   - Unbalanced HubL tags (stack-based fix)
   - Reserved field names (`name` -> `item_name`, `label` -> `section_label`)
   - Deprecated field types (`textarea` -> `text`)
   - CDN `@import` stripping
   - `now()` -> `local_dt`
   - Missing `meta.json` required fields

### Key Constraints

- **Structured output.** API engines use JSON schema for reliable parsing. CLI engines use subprocess spawning with prompt piping.
- **No external dependencies in generated modules.** All CSS/JS must be self-contained. No Google Fonts imports, no CDN links.
- **Field names are kebab-case.** The pipeline validates this.
- **Session state uses case-insensitive module matching** to prevent duplicates when updating.

### Adding a New Pipeline Stage

1. Create a file in `src/server/agent/stages/`.
2. Export an async function that takes the pipeline context and returns its output.
3. Add the corresponding JSON schema in `src/server/agent/prompts/` if using structured output.
4. Wire it into the pipeline in `src/server/agent/pipeline.ts`.
5. Emit `agent_step` and `agent_decision` WebSocket events for UI progress.

### Adding a Starter Template

Starter templates live in `starters/` as JSON files. Each is a self-contained bundle with modules, shared CSS/JS, and module order. To add one:

1. Create a JSON file in `starters/` following the existing format.
2. The file is auto-discovered by `src/server/starters.ts`.

## Documentation Updates

When a feature or fix ships, update the relevant docs before merging:

| Doc | When |
|-----|------|
| `CHANGELOG.md` | Always |
| `README.md` | User-facing feature or setup change |
| `ui/docs/index.html` | Affects documented features or workflows |
| `CLAUDE.md` | Architecture, constraints, or key behaviors change |

## Code of Conduct

This project follows the Contributor Covenant Code of Conduct. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

vibeSpot is licensed under FSL-1.1-Apache-2.0. By contributing, you agree that your contributions will be licensed under the same terms.
