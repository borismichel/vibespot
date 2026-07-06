/**
 * Preview management — iframe loading and module scrolling.
 *
 * VIB-1892: the live preview loads from a SEPARATE ORIGIN (see
 * src/server/preview-origin.ts), so AI-generated page code is cross-origin to
 * the app and can never touch this document or the app's /api routes. The
 * parent never reaches into contentDocument; everything in-frame is done by
 * the trusted preview agent over the narrow vs:* postMessage protocol
 * (src/server/preview-protocol.ts). This file owns the parent end of that
 * channel; inline-edit.js / section-controls.js register handlers on it.
 */

const previewFrame = document.getElementById("preview-frame");
const previewEmptyState = document.getElementById("preview-empty-state");

// ---------------------------------------------------------------------------
// Preview-origin channel (parent end)
// ---------------------------------------------------------------------------

const VS_PROTOCOL_V = 1;
/** Preview -> parent verbs the parent will dispatch. Locked to
 * src/server/preview-protocol.ts by test/preview-protocol-parity.test.ts. */
const VS_PREVIEW_TO_PARENT = new Set([
  "vs:ready",
  "vs:empty-state",
  "vs:select-module",
  "vs:edit-commit",
  "vs:field-commit",
  "vs:request-mode",
]);

/** { origin, token } once /api/preview-origin resolves; null while loading. */
let previewOriginInfo = null;
let previewOriginPromise = null;
/** True between the agent's vs:ready and the next navigation. */
let previewAgentReady = false;
/** Bumped per navigation to force a fresh document load. */
let previewLoadSeq = 0;
/** Current interaction mode, re-sent to the agent on every (re)load. */
let currentPreviewMode = "view";

const previewMessageHandlers = new Map();

/** Register a parent-side handler for a preview->parent verb. */
function onPreviewMessage(type, handler) {
  previewMessageHandlers.set(type, handler);
}

/** Send a command to the in-frame agent (drops silently until ready). */
function sendPreviewCommand(type, payload) {
  if (!previewOriginInfo || !previewAgentReady || !previewFrame.contentWindow) return;
  previewFrame.contentWindow.postMessage(
    { v: VS_PROTOCOL_V, token: previewOriginInfo.token, type, payload },
    previewOriginInfo.origin
  );
}

/** Track + broadcast the interaction mode (called by inline-edit.js). */
function setPreviewMode(mode) {
  currentPreviewMode = mode === "interact" || mode === "section" ? mode : "view";
  sendPreviewCommand("vs:set-mode", { mode: currentPreviewMode });
}

function fetchPreviewOriginInfo() {
  if (previewOriginPromise) return previewOriginPromise;
  previewOriginPromise = fetch("/api/preview-origin")
    .then((res) => res.json())
    .then((data) => {
      if (data && typeof data.origin === "string" && typeof data.token === "string") {
        previewOriginInfo = { origin: data.origin.replace(/\/$/, ""), token: data.token };
      } else {
        console.error("Preview origin unavailable — live preview disabled.");
      }
      return previewOriginInfo;
    })
    .catch((err) => {
      console.error("Failed to resolve preview origin:", err);
      previewOriginPromise = null; // allow a retry on the next refresh
      return null;
    });
  return previewOriginPromise;
}

window.addEventListener("message", (event) => {
  // Gate 1: the message must come from the preview origin AND from our frame.
  if (!previewOriginInfo) return;
  if (event.origin !== previewOriginInfo.origin) return;
  if (event.source !== previewFrame.contentWindow) return;
  // Gate 2: envelope — version, token, direction-scoped verb allow-list.
  const env = event.data;
  if (!env || typeof env !== "object") return;
  if (env.v !== VS_PROTOCOL_V) return;
  if (typeof env.token !== "string" || env.token !== previewOriginInfo.token) return;
  if (!VS_PREVIEW_TO_PARENT.has(env.type)) return;

  if (env.type === "vs:ready") {
    previewAgentReady = true;
    sendPreviewCommand("vs:init", { mode: currentPreviewMode });
    flushPendingHighlights();
    return;
  }
  const handler = previewMessageHandlers.get(env.type);
  if (handler) handler(env.payload || {});
});

// ---------------------------------------------------------------------------
// Empty state + change highlighting
// ---------------------------------------------------------------------------

// Highlights to apply once the agent reports ready after the next refresh.
let pendingChangedModules = null;
let pendingNewModules = null;

/**
 * Show or hide the preview empty state. Driven by the agent's vs:empty-state
 * report after each load (the parent cannot inspect the cross-origin doc).
 */
function setPreviewEmptyState(show) {
  if (!previewEmptyState) return;
  previewEmptyState.setAttribute("aria-hidden", show ? "false" : "true");
}

onPreviewMessage("vs:empty-state", (p) => {
  setPreviewEmptyState(!p.hasModules);
});

function flushPendingHighlights() {
  if (!pendingChangedModules && !pendingNewModules) return;
  const changed = pendingChangedModules;
  const fresh = pendingNewModules;
  pendingChangedModules = null;
  pendingNewModules = null;
  sendPreviewCommand("vs:highlight-changed", { changed: changed || [], fresh: fresh || [] });
}

/**
 * Refresh the preview iframe by (re)navigating it to the preview origin.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.changedModules] Module names that were just regenerated.
 * @param {string[]} [opts.newModules]     Subset of changedModules that are first-time additions.
 */
function refreshPreview(opts) {
  if (opts && (opts.changedModules || opts.newModules)) {
    pendingChangedModules = opts.changedModules || null;
    pendingNewModules = opts.newModules || null;
  }
  // The origin lookup is async — only the newest requested navigation may
  // touch the frame, or a slow resolve clobbers a later refresh or the
  // generating screen (VIB-1898).
  previewLoadSeq += 1;
  const nav = previewLoadSeq;
  fetchPreviewOriginInfo().then((info) => {
    if (nav !== previewLoadSeq) return; // superseded while resolving
    if (!info) {
      // The preview origin never resolved (stale cached client hitting a
      // moved route, the origin process not running, or the port blocked).
      // Surface a self-diagnosing message instead of a silent blank frame.
      showPreviewUnavailable();
      return;
    }
    previewAgentReady = false;
    // The `r` param defeats bfcache/no-op navigations; `t` is the access token.
    previewFrame.removeAttribute("srcdoc");
    previewFrame.src = `${info.origin}/?t=${encodeURIComponent(info.token)}&r=${nav}`;
  });
}

/**
 * Scroll the preview iframe to a specific module by name.
 */
function scrollPreviewToModule(moduleName) {
  sendPreviewCommand("vs:scroll-to", { module: moduleName });
}

/**
 * Show the generating preview — spinner + rotating fun messages.
 * Trusted static content (no AI code), so srcdoc is fine here.
 */
function showGeneratingPreview() {
  setPreviewEmptyState(false);
  previewAgentReady = false;
  // Invalidate any refresh navigation still resolving its origin lookup so it
  // can't replace this screen after we show it (VIB-1898).
  previewLoadSeq += 1;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0c0a09;
    color: rgba(255,255,255,0.45);
  }
  .gen {
    text-align: center;
    padding: 2rem;
  }
  .gen p {
    font-size: 1.1rem;
    line-height: 1.6;
    max-width: 440px;
    transition: opacity 0.6s ease;
  }
  .gen p.fade { opacity: 0; }
  .spinner {
    width: 44px;
    height: 44px;
    margin: 0 auto 1.5rem;
    border: 3px solid rgba(232, 97, 58, 0.12);
    border-top-color: rgba(232, 97, 58, 0.7);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="gen">
  <div class="spinner"></div>
  <p id="msg"></p>
</div>
<script>
  var lines = [
    "Choosing the perfect fonts\\u2026 no Comic Sans, we promise",
    "Writing headlines that hit different\\u2026",
    "Crafting testimonials that sound real, not robotic\\u2026",
    "Setting up a pricing section\\u2026 transparent, no hidden fees",
    "Adding the finishing touches\\u2026 micro-animations & hover states",
    "Picking colors that actually work together\\u2026",
    "Building your hero section\\u2026 first impressions matter",
    "Creating a navigation that just makes sense\\u2026",
    "Hold tight \\u2014 great pages take a moment\\u2026",
    "Generating responsive layouts that look good everywhere\\u2026",
    "Making your page scroll-stoppingly good\\u2026",
    "Assembling your FAQ section\\u2026 answering questions before they\\u2019re asked",
    "Designing call-to-action buttons people actually want to click\\u2026",
    "Adding trust signals\\u2026 because credibility matters",
    "Polishing the footer\\u2026 every detail counts"
  ];
  var idx = Math.floor(Math.random() * lines.length);
  var el = document.getElementById("msg");
  el.textContent = lines[idx];
  setInterval(function() {
    el.classList.add("fade");
    setTimeout(function() {
      idx = (idx + 1) % lines.length;
      el.textContent = lines[idx];
      el.classList.remove("fade");
    }, 600);
  }, 4000);
<\/script>
</body>
</html>`;
  previewFrame.removeAttribute("src");
  previewFrame.srcdoc = html;
}

/**
 * Show a visible in-frame fallback when the preview origin can't be resolved
 * (`/api/preview-origin` returned `{origin:null}` or the fetch failed). Without
 * this the frame just stays blank and the failure is invisible — the classic
 * symptom of a stale cached `ui/preview.js` running against an upgraded server,
 * or the preview origin process not being reachable (VIB-1937). Trusted static
 * content (no AI code), so srcdoc is fine here.
 */
function showPreviewUnavailable() {
  previewAgentReady = false;
  // Compute the expected preview port (app port + 2) so the hint is concrete.
  const appPort = Number(
    window.location.port || (window.location.protocol === "https:" ? 443 : 80)
  );
  const previewPort = Number.isFinite(appPort) ? appPort + 2 : null;
  const portHint = previewPort
    ? `the preview port (<code>${previewPort}</code>, i.e. app port + 2)`
    : "the preview port (app port + 2)";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0c0a09;
    color: rgba(255,255,255,0.62);
    padding: 2rem;
  }
  .unavail {
    text-align: center;
    max-width: 460px;
  }
  .unavail .icon {
    font-size: 2.2rem;
    margin-bottom: 1rem;
    opacity: 0.7;
  }
  .unavail h1 {
    font-size: 1.15rem;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
    margin-bottom: 0.75rem;
  }
  .unavail p {
    font-size: 0.95rem;
    line-height: 1.6;
    margin-bottom: 0.6rem;
  }
  .unavail ul {
    text-align: left;
    display: inline-block;
    margin: 0.4rem auto 0;
    padding-left: 1.1rem;
    font-size: 0.9rem;
    line-height: 1.7;
  }
  .unavail code {
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.85em;
    background: rgba(255,255,255,0.08);
    padding: 0.1em 0.4em;
    border-radius: 4px;
    color: rgba(232, 97, 58, 0.95);
  }
  .unavail kbd {
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.8em;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.15);
    border-bottom-width: 2px;
    padding: 0.1em 0.4em;
    border-radius: 4px;
    white-space: nowrap;
  }
</style>
</head>
<body>
<div class="unavail">
  <div class="icon">&#9888;</div>
  <h1>Live preview unavailable</h1>
  <p>The editor couldn't reach the preview server, so the page can't render here yet.</p>
  <p>Two things usually fix it:</p>
  <ul>
    <li>Hard-refresh this page (<kbd>Cmd/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>) to load the latest editor after an upgrade.</li>
    <li>Make sure ${portHint} is free and reachable.</li>
  </ul>
</div>
</body>
</html>`;
  previewFrame.removeAttribute("src");
  previewFrame.srcdoc = html;
}

// ---------------------------------------------------------------------------
// "Working on it" overlays — forwarded to the in-frame agent
// ---------------------------------------------------------------------------

/**
 * Mark modules as "being worked on" — the agent adds the blur overlay with
 * rotating messages in-frame.
 */
function markModulesWorking(moduleNames) {
  sendPreviewCommand("vs:mark-working", { modules: moduleNames });
}

/**
 * Clear working overlay from a specific module (when it completes).
 */
function clearModuleWorking(moduleName) {
  sendPreviewCommand("vs:clear-working", { modules: [moduleName] });
}

/**
 * Clear all working overlays.
 */
function clearAllModulesWorking() {
  sendPreviewCommand("vs:clear-working", {});
}

// Preview refresh is triggered by setup.js after a session is created.
// Do NOT auto-refresh here — but resolve the preview origin early so the
// first refresh doesn't pay the round-trip.
fetchPreviewOriginInfo();

// ---------------------------------------------------------------------------
// HubL validity badge — aggregates per-module checks reported by chat.js into
// a single status pill in the preview toolbar.
// ---------------------------------------------------------------------------

const hublBadgeEl = document.getElementById("hubl-badge");
const hublBadgeLabelEl = hublBadgeEl ? hublBadgeEl.querySelector(".hubl-badge__label") : null;
const hublBadgeCountEl = document.getElementById("hubl-badge-count");
const hublModuleIssues = new Map();
let hublBadgeReveal = null;

function applyHublBadgeState() {
  if (!hublBadgeEl) return;
  let totalIssues = 0;
  for (const issues of hublModuleIssues.values()) totalIssues += issues.length;
  const failedModules = Array.from(hublModuleIssues.values()).filter((arr) => arr.length > 0).length;

  const state = totalIssues === 0 ? "valid" : "issues";
  hublBadgeEl.dataset.state = state;
  hublBadgeEl.classList.toggle("hubl-badge--valid", state === "valid");
  hublBadgeEl.classList.toggle("hubl-badge--issues", state === "issues");

  if (hublBadgeLabelEl) {
    hublBadgeLabelEl.textContent = state === "valid" ? "Valid HubL" : "HubL issues";
  }
  if (hublBadgeCountEl) {
    if (state === "valid") {
      hublBadgeCountEl.classList.add("hidden");
      hublBadgeCountEl.textContent = "";
    } else {
      hublBadgeCountEl.classList.remove("hidden");
      hublBadgeCountEl.textContent = String(totalIssues);
    }
  }

  if (state === "valid") {
    const checked = hublModuleIssues.size;
    hublBadgeEl.title = checked === 0
      ? "HubL syntax check — no modules generated yet."
      : `HubL syntax check — all ${checked} module${checked === 1 ? "" : "s"} parse cleanly.`;
  } else {
    hublBadgeEl.title = `${totalIssues} HubL issue${totalIssues === 1 ? "" : "s"} across ${failedModules} module${failedModules === 1 ? "" : "s"}. Click to review.`;
  }
}

function flashHublBadge() {
  if (!hublBadgeEl) return;
  hublBadgeEl.classList.remove("hubl-badge--flash");
  // Force reflow so the animation restarts.
  void hublBadgeEl.offsetWidth;
  hublBadgeEl.classList.add("hubl-badge--flash");
}

window.resetHublCheck = function () {
  hublModuleIssues.clear();
  applyHublBadgeState();
};

window.reportHublCheck = function (moduleName, issues) {
  if (!moduleName) return;
  hublModuleIssues.set(moduleName, Array.isArray(issues) ? issues : []);
  applyHublBadgeState();
  flashHublBadge();
};

if (hublBadgeEl) {
  applyHublBadgeState();
  hublBadgeEl.addEventListener("click", () => {
    if (hublBadgeEl.dataset.state !== "issues") return;
    const lines = [];
    for (const [name, issues] of hublModuleIssues) {
      if (!issues.length) continue;
      lines.push(`• ${name}: ${issues.map((i) => i.message || i.kind).join(", ")}`);
    }
    if (typeof appendSystemMessage === "function") {
      appendSystemMessage(`HubL issues in current run:\n${lines.join("\n")}`);
    } else {
      console.warn("HubL issues:\n" + lines.join("\n"));
    }
  });
}
