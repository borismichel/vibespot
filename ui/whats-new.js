/**
 * "What's new" release dialog — shown once after a version upgrade.
 *
 * SCAFFOLD (VIB-1886): UX + clickable demo only. Production gating
 * (lastSeenVersion read/write, server route) is a follow-up owned by CTO.
 *
 * Mount points:
 *   - Production seam:  maybeShowWhatsNew({ currentVersion, lastSeenVersion, onDismiss })
 *   - Demo / screenshots: add ?whatsnew=1 to the URL (search OR hash query) and
 *     this file self-renders the modal over whatever view is loaded.
 *
 * Reuses the existing overlay pattern (see ui/dialog.js) and the design tokens
 * in ui/styles.css. No new visual language, no one-off values.
 */

// HTML-escape helper — guard for load order (dialog.js usually defines `esc`).
if (typeof esc === "undefined") {
  // eslint-disable-next-line no-var
  var _wnEscMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  // eslint-disable-next-line no-var
  var esc = function (str) {
    return String(str).replace(/[&<>"']/g, function (c) { return _wnEscMap[c]; });
  };
}

/**
 * Release content. In production this is sourced from the current CHANGELOG.md
 * section (CTO follow-up). For the scaffold it's the real, condensed 1.7.x story
 * (the 1.7.1–1.7.7 entries shipped together on 2026-06-27 — checkpoints + softened
 * barge-in). Copy run through the humanify standard: verbs lead, no buzzwords.
 */
const WHATS_NEW = {
  version: "1.7.7",
  date: "June 27, 2026",
  changelogUrl: "https://github.com/borismichel/vibespot/blob/main/CHANGELOG.md",
  highlights: [
    {
      title: "Checkpoints survive interruptions",
      body: "Refresh the tab, lock your iPad, or restart the server. An open design, structure, or brand checkpoint comes back exactly where you left it instead of expiring.",
    },
    {
      title: "Mid-build messages wait their turn",
      body: "Type while a page is generating and your message queues as “runs next” instead of cancelling the build. Hit Interrupt now when you want to change course.",
    },
    {
      title: "Every decision is on the record",
      body: "Approving a checkpoint leaves a line in the chat: the palette and fonts you chose, the sections you kept. You can see what you signed off on.",
    },
  ],
};

// Four-pointed brand star (same mark as the topbar logo), accent-gradient fill.
const _WN_STAR = `
  <svg viewBox="0 0 512 512" width="22" height="22" aria-hidden="true">
    <defs>
      <linearGradient id="wn-star-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#e8613a"/>
        <stop offset="1" stop-color="#f2825f"/>
      </linearGradient>
    </defs>
    <path d="M256 76 Q280 220 436 256 Q280 292 256 436 Q232 292 76 256 Q232 220 256 76 Z" fill="url(#wn-star-grad)"/>
  </svg>`;

let _wnOpen = false;

/**
 * Render the "what's new" modal.
 * @param {object} [opts]
 * @param {object} [opts.content] — release content (defaults to WHATS_NEW)
 * @param {Function} [opts.onDismiss] — called when the user dismisses the modal
 * @returns {Promise<void>} resolves on dismiss
 */
function showWhatsNew(opts) {
  opts = opts || {};
  const content = opts.content || WHATS_NEW;
  if (_wnOpen) return Promise.resolve();
  _wnOpen = true;

  return new Promise((resolve) => {
    const lastFocused = document.activeElement;

    const overlay = document.createElement("div");
    overlay.className = "whatsnew-overlay";

    const bullets = content.highlights.map((h) => `
      <li class="whatsnew__item">
        <span class="whatsnew__marker" aria-hidden="true">${_WN_STAR}</span>
        <div class="whatsnew__item-text">
          <span class="whatsnew__item-title">${esc(h.title)}</span>
          <span class="whatsnew__item-body">${esc(h.body)}</span>
        </div>
      </li>`).join("");

    overlay.innerHTML = `
      <div class="whatsnew-dialog" role="dialog" aria-modal="true"
           aria-labelledby="whatsnew-title" aria-describedby="whatsnew-desc">
        <button class="whatsnew__close" type="button" data-action="dismiss" aria-label="Close">
          <svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>

        <div class="whatsnew__brand">
          <span class="whatsnew__logo">${_WN_STAR}</span>
          <span class="whatsnew__wordmark">vibeSpot</span>
          <span class="whatsnew__version">v${esc(content.version)}</span>
        </div>

        <h2 class="whatsnew__title" id="whatsnew-title">What’s new in vibeSpot ${esc(content.version)}</h2>
        <p class="whatsnew__date" id="whatsnew-desc">Released ${esc(content.date)}</p>

        <ul class="whatsnew__list">${bullets}</ul>

        <div class="whatsnew__actions">
          <button class="btn btn--secondary" type="button" data-action="dismiss">Got it</button>
          <a class="btn btn--primary" href="${esc(content.changelogUrl)}"
             target="_blank" rel="noopener noreferrer" data-action="changelog">
            Read the full changelog
          </a>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const dialog = overlay.querySelector(".whatsnew-dialog");
    const focusables = dialog.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');

    const close = () => {
      if (!_wnOpen) return;
      _wnOpen = false;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (typeof opts.onDismiss === "function") opts.onDismiss();
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
      resolve();
    };

    // Dismiss affordances: ✕, "Got it", backdrop click. The changelog link
    // opens in a new tab and also counts as "seen" so it never nags again.
    overlay.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]");
      if (e.target === overlay) return close();           // backdrop
      if (!action) return;
      if (action.dataset.action === "changelog") { close(); return; } // let the link open
      e.preventDefault();
      close();
    });

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); return close(); }
      if (e.key === "Tab" && focusables.length) {          // simple focus trap
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);

    // Focus the primary action so keyboard users land inside the dialog.
    setTimeout(() => {
      const primary = dialog.querySelector('[data-action="changelog"]');
      if (primary) primary.focus();
    }, 50);
  });
}

/**
 * Production seam (CTO follow-up wires this on web-UI load).
 * Shows the modal once per release: when the installed version differs from the
 * version this user last dismissed. On dismiss, persist lastSeenVersion.
 *
 * @param {object} args
 * @param {string} args.currentVersion   — package.json version
 * @param {string} [args.lastSeenVersion]— from ~/.vibespot/config.json
 * @param {Function} [args.onDismiss]    — persist callback (write lastSeenVersion)
 * @param {object} [args.content]        — release content from CHANGELOG.md
 * @returns {boolean} whether the modal was shown
 */
function maybeShowWhatsNew(args) {
  args = args || {};
  if (!args.currentVersion) return false;
  if (args.currentVersion === args.lastSeenVersion) return false;
  showWhatsNew({
    content: args.content,
    onDismiss: () => {
      if (typeof args.onDismiss === "function") args.onDismiss(args.currentVersion);
    },
  });
  return true;
}

// --- Demo trigger (scaffold only) ------------------------------------------
// ?whatsnew=1 in the query string OR after the hash (e.g. #/app/foo?whatsnew=1)
// renders the modal so it can be captured standalone for screenshots.
function _wnDemoRequested() {
  const inSearch = new URLSearchParams(window.location.search).get("whatsnew") === "1";
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  const inHash = qIndex !== -1 &&
    new URLSearchParams(hash.slice(qIndex + 1)).get("whatsnew") === "1";
  return inSearch || inHash;
}

function _wnInitDemo() {
  if (_wnDemoRequested()) {
    // Small delay so the builder chrome paints first (modal sits over it).
    setTimeout(() => showWhatsNew(), 400);
  }
}

// --- Production bootstrap (VIB-1885) ----------------------------------------
// On launch, ask the server whether there's an undismissed release to show.
// The server reads assets/whats-new.json (generated from CHANGELOG.md) and
// gates on config.lastSeenVersion, so this surfaces once per upgrade. Dismissing
// persists lastSeenVersion via POST /api/whats-new/dismiss so it never nags again.
function _wnInitProd() {
  if (_wnDemoRequested()) return; // demo path owns the modal
  fetch("/api/whats-new")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.show || !data.content) return;
      maybeShowWhatsNew({
        currentVersion: data.content.version,
        lastSeenVersion: null, // server already decided show=true
        content: data.content,
        onDismiss: (version) => {
          fetch("/api/whats-new/dismiss", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version }),
          }).catch(() => {});
        },
      });
    })
    .catch(() => {}); // network/offline: silently skip — never block the app
}

function _wnInit() {
  _wnInitDemo();
  _wnInitProd();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _wnInit);
} else {
  _wnInit();
}
