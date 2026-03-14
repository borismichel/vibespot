/**
 * Shared modal dialog utilities — styled replacements for native alert/confirm/prompt.
 * Uses the existing .confirm-overlay / .confirm-dialog CSS pattern.
 */

// HTML-escape helper (standalone so dialog.js has no load-order dependency)
if (typeof esc === "undefined") {
  // eslint-disable-next-line no-var
  var _escMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var esc = function (str) {
    return String(str).replace(/[&<>"']/g, function (c) { return _escMap[c]; });
  };
}

/**
 * Show a styled alert dialog (replaces window.alert).
 * @param {string} message — the message to display
 * @param {string} [title] — optional dialog title
 * @returns {Promise<void>}
 */
function vibeAlert(message, title) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        ${title ? `<div class="confirm-dialog__title">${esc(title)}</div>` : ""}
        <p class="confirm-dialog__detail">${esc(message)}</p>
        <div class="confirm-dialog__actions">
          <button class="btn btn--primary" data-action="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector('[data-action="ok"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  });
}

/**
 * Show a styled confirm dialog (replaces window.confirm).
 * @param {string} title — dialog title / question
 * @param {string} [detail] — optional detail text
 * @param {object} [opts] — options: { confirmLabel, confirmClass }
 * @returns {Promise<boolean>}
 */
function vibeConfirm(title, detail, opts) {
  const label = (opts && opts.confirmLabel) || "Confirm";
  const btnClass = (opts && opts.confirmClass) || "btn--danger";
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">${esc(title)}</div>
        ${detail ? `<p class="confirm-dialog__warn">${esc(detail)}</p>` : ""}
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" data-action="cancel">Cancel</button>
          <button class="btn ${btnClass}" data-action="confirm">${esc(label)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
  });
}

/**
 * Show a styled prompt dialog with an input field (replaces window.prompt).
 * @param {string} title — dialog title
 * @param {string} [defaultValue] — pre-filled input value
 * @param {string} [placeholder] — input placeholder
 * @returns {Promise<string|null>} — input value or null if cancelled
 */
function vibePrompt(title, defaultValue, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">${esc(title)}</div>
        <input
          type="text"
          class="confirm-dialog__input"
          value="${esc(defaultValue || "")}"
          placeholder="${esc(placeholder || "")}"
          data-role="input"
        />
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" data-action="cancel">Cancel</button>
          <button class="btn btn--primary" data-action="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('[data-role="input"]');
    setTimeout(() => { input.focus(); input.select(); }, 50);

    const close = (val) => { overlay.remove(); resolve(val); };

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => close(input.value));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value);
      if (e.key === "Escape") close(null);
    });
  });
}

/**
 * Show a large scrollable content viewer dialog with rendered markdown.
 * Uses the `marked` library (loaded via vendor/marked.umd.js).
 * @param {string} content — markdown text to display
 * @param {string} [title] — dialog title
 * @returns {Promise<void>}
 */
function vibeViewContent(content, title) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const dialog = document.createElement("div");
    dialog.className = "confirm-dialog confirm-dialog--wide";

    if (title) {
      dialog.innerHTML = '<div class="confirm-dialog__title">' + esc(title) + '</div>';
    }

    const body = document.createElement("div");
    body.className = "confirm-dialog__content-view md-body";
    body.innerHTML = typeof marked !== "undefined" ? marked.parse(content) : esc(content);
    dialog.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "confirm-dialog__actions";
    actions.innerHTML = '<button class="btn btn--primary" data-action="ok">Close</button>';
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector('[data-action="ok"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(); }
    });
  });
}
