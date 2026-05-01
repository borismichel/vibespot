/**
 * Preview management — iframe loading and module scrolling.
 */

const previewFrame = document.getElementById("preview-frame");

// Highlights to apply once the iframe finishes loading after the next refresh.
let pendingChangedModules = null;
let pendingNewModules = null;

previewFrame.addEventListener("load", () => {
  if (!pendingChangedModules && !pendingNewModules) return;
  const changed = pendingChangedModules;
  const fresh = pendingNewModules;
  pendingChangedModules = null;
  pendingNewModules = null;
  try {
    const doc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    if (!doc || !doc.body) return;
    ensureChangeHighlightStyles(doc);
    if (fresh && fresh.length) animateNewModules(doc, fresh);
    if (changed && changed.length) highlightChangedModules(doc, changed, fresh || []);
  } catch {
    // cross-origin — skip
  }
});

/**
 * Refresh the preview iframe by reloading from /preview endpoint.
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
  // Use srcdoc approach: fetch preview HTML and set as srcdoc
  // This avoids cache issues and allows the iframe to update smoothly
  fetch("/preview")
    .then((res) => res.text())
    .then((html) => {
      previewFrame.srcdoc = html;
    })
    .catch((err) => {
      console.error("Preview refresh failed:", err);
    });
}

// ---------------------------------------------------------------------------
// Change highlighting — outline glow on regenerated modules and slide-in for
// brand-new modules. Styles are injected into the sandboxed preview iframe.
// ---------------------------------------------------------------------------

function ensureChangeHighlightStyles(doc) {
  if (doc.getElementById("vibespot-change-highlight-css")) return;
  const style = doc.createElement("style");
  style.id = "vibespot-change-highlight-css";
  style.textContent = `
    @keyframes vibespot-change-glow {
      0%   { outline-color: rgba(232, 97, 58, 0.85); box-shadow: 0 0 0 6px rgba(232, 97, 58, 0.18); }
      70%  { outline-color: rgba(232, 97, 58, 0.55); box-shadow: 0 0 0 4px rgba(232, 97, 58, 0.10); }
      100% { outline-color: rgba(232, 97, 58, 0);    box-shadow: 0 0 0 0 rgba(232, 97, 58, 0);    }
    }
    .vibespot-module--changed {
      outline: 2px solid rgba(232, 97, 58, 0.85);
      outline-offset: 4px;
      border-radius: 2px;
      animation: vibespot-change-glow 2s ease-out forwards;
    }
    @keyframes vibespot-module-slide-in {
      0%   { opacity: 0; transform: translateY(24px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    .vibespot-module--new {
      animation: vibespot-module-slide-in 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    @media (prefers-reduced-motion: reduce) {
      .vibespot-module--changed,
      .vibespot-module--new { animation: none; }
      .vibespot-module--changed { outline-color: transparent; }
    }
  `;
  doc.head.appendChild(style);
}

function highlightChangedModules(doc, moduleNames, newModuleNames) {
  // Skip modules that are already getting the slide-in animation — the slide-in
  // is a stronger signal on its own.
  const newSet = new Set(newModuleNames);
  for (const name of moduleNames) {
    if (newSet.has(name)) continue;
    const el = doc.querySelector(`[data-module="${cssEscape(name)}"]`);
    if (!el) continue;
    el.classList.remove("vibespot-module--changed");
    // Force a reflow so the animation restarts if the class was just removed.
    void el.offsetWidth;
    el.classList.add("vibespot-module--changed");
    setTimeout(() => {
      el.classList.remove("vibespot-module--changed");
    }, 2200);
  }
}

function animateNewModules(doc, moduleNames) {
  for (const name of moduleNames) {
    const el = doc.querySelector(`[data-module="${cssEscape(name)}"]`);
    if (!el) continue;
    el.classList.add("vibespot-module--new");
    setTimeout(() => {
      el.classList.remove("vibespot-module--new");
    }, 700);
  }
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

/**
 * Scroll the preview iframe to a specific module by name.
 */
function scrollPreviewToModule(moduleName) {
  try {
    const doc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    const el = doc.querySelector(`[data-module="${moduleName}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });

      // Brief highlight effect
      el.style.outline = "2px solid #e8613a";
      el.style.outlineOffset = "4px";
      el.style.transition = "outline-color 0.5s ease";
      setTimeout(() => {
        el.style.outlineColor = "transparent";
        setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 500);
      }, 1500);
    }
  } catch {
    // Cross-origin issues — fall back to simple reload
  }
}

/**
 * Show the generating preview — spinner + rotating fun messages.
 * Called when AI generation starts to entertain the user while waiting.
 */
function showGeneratingPreview() {
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
  previewFrame.srcdoc = html;
}

// ---------------------------------------------------------------------------
// "Working on it" overlay for modules being regenerated
// ---------------------------------------------------------------------------

const WORKING_MESSAGES = [
  "Rethinking this section\u2026",
  "Rewriting the code\u2026",
  "Giving this a fresh coat of paint\u2026",
  "Making it better\u2026",
  "Tweaking the layout\u2026",
  "Polishing the details\u2026",
  "Almost there\u2026",
  "Updating the design\u2026",
  "Improving the copy\u2026",
  "Refining the structure\u2026",
];

/**
 * Inject the overlay CSS into the preview iframe (once).
 */
function ensureOverlayStyles(doc) {
  if (doc.getElementById("vibespot-working-css")) return;
  const style = doc.createElement("style");
  style.id = "vibespot-working-css";
  style.textContent = `
    .vibespot-module--working { position: relative; }
    .vibespot-module--working > *:not(.vibespot-working-overlay) {
      filter: blur(3px) saturate(0.4);
      opacity: 0.5;
      transition: filter 0.4s ease, opacity 0.4s ease;
      pointer-events: none;
    }
    .vibespot-working-overlay {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 9999;
      pointer-events: none;
    }
    .vibespot-working-overlay__spinner {
      width: 36px; height: 36px;
      border: 3px solid rgba(232,97,58,0.15);
      border-top-color: rgba(232,97,58,0.8);
      border-radius: 50%;
      animation: vw-spin 0.8s linear infinite;
      margin-bottom: 12px;
    }
    .vibespot-working-overlay__text {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px; font-weight: 500;
      color: rgba(255,255,255,0.7);
      text-align: center;
      max-width: 280px;
      transition: opacity 0.5s ease;
    }
    .vibespot-working-overlay__text.fade { opacity: 0; }
    @keyframes vw-spin { to { transform: rotate(360deg); } }
  `;
  doc.head.appendChild(style);
}

/** Active carousel intervals keyed by module name */
const workingIntervals = new Map();

/**
 * Mark modules as "being worked on" — adds blur overlay with rotating messages.
 */
function markModulesWorking(moduleNames) {
  try {
    const doc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    if (!doc || !doc.body) return;
    ensureOverlayStyles(doc);

    for (const name of moduleNames) {
      const el = doc.querySelector(`[data-module="${name}"]`);
      if (!el || el.classList.contains("vibespot-module--working")) continue;

      el.classList.add("vibespot-module--working");

      const overlay = doc.createElement("div");
      overlay.className = "vibespot-working-overlay";
      overlay.innerHTML = `
        <div class="vibespot-working-overlay__spinner"></div>
        <div class="vibespot-working-overlay__text"></div>
      `;
      el.appendChild(overlay);

      // Scroll to first working module
      if (name === moduleNames[0]) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Start message carousel
      const textEl = overlay.querySelector(".vibespot-working-overlay__text");
      let idx = Math.floor(Math.random() * WORKING_MESSAGES.length);
      textEl.textContent = WORKING_MESSAGES[idx];

      const interval = setInterval(() => {
        textEl.classList.add("fade");
        setTimeout(() => {
          idx = (idx + 1) % WORKING_MESSAGES.length;
          textEl.textContent = WORKING_MESSAGES[idx];
          textEl.classList.remove("fade");
        }, 500);
      }, 3500);
      workingIntervals.set(name, interval);
    }
  } catch { /* cross-origin */ }
}

/**
 * Clear working overlay from a specific module (when it completes).
 */
function clearModuleWorking(moduleName) {
  const interval = workingIntervals.get(moduleName);
  if (interval) { clearInterval(interval); workingIntervals.delete(moduleName); }

  try {
    const doc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    if (!doc) return;
    const el = doc.querySelector(`[data-module="${moduleName}"]`);
    if (!el) return;
    el.classList.remove("vibespot-module--working");
    const overlay = el.querySelector(".vibespot-working-overlay");
    if (overlay) overlay.remove();
  } catch { /* cross-origin */ }
}

/**
 * Clear all working overlays.
 */
function clearAllModulesWorking() {
  for (const [name, interval] of workingIntervals) {
    clearInterval(interval);
  }
  workingIntervals.clear();

  try {
    const doc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    if (!doc) return;
    doc.querySelectorAll(".vibespot-module--working").forEach((el) => {
      el.classList.remove("vibespot-module--working");
      const overlay = el.querySelector(".vibespot-working-overlay");
      if (overlay) overlay.remove();
    });
  } catch { /* cross-origin */ }
}

// Preview refresh is triggered by setup.js after a session is created.
// Do NOT auto-refresh here.

// Select/edit mode has been unified into interact mode (inline-edit.js)
