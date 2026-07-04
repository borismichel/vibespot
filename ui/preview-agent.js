/**
 * Trusted in-frame preview agent (VIB-1892).
 *
 * Served by the separate preview origin and injected at the top of <head> of
 * every composed preview doc, so it boots BEFORE any AI-generated module
 * script. It owns all in-document interaction (hover labels, inline editing,
 * section controls, change highlights, working overlays) and talks to the app
 * over the narrow vs:* postMessage protocol — see src/server/preview-protocol.ts
 * for the contract. The verb strings here are locked to that module by
 * test/preview-protocol-parity.test.ts.
 *
 * Trust model: this script and the AI page share one JS realm, so nothing in
 * here is a secret from the page. Security comes from the origin split + the
 * protocol's tiny write vocabulary (field edits only), not from hiding state.
 * Still, the handshake token is scrubbed from the URL and config block before
 * AI code runs so it can't leak into rendered output.
 */
(() => {
  "use strict";

  // ---- bootstrap config (runs at parse time, before any AI script) --------
  var TOKEN = "";
  var cfgEl = document.getElementById("vs-preview-config");
  if (cfgEl) {
    try { TOKEN = String(JSON.parse(cfgEl.textContent).token || ""); } catch { /* no token — agent stays mute */ }
    cfgEl.remove();
  }
  var FIELDS = {};
  var fieldsEl = document.getElementById("vs-preview-fields");
  if (fieldsEl) {
    try { FIELDS = JSON.parse(fieldsEl.textContent) || {}; } catch { /* no controls */ }
    fieldsEl.remove();
  }
  // Scrub the access token out of the address bar so DOM-reading AI code
  // can't echo it into rendered output.
  try { history.replaceState(null, "", location.pathname); } catch { /* sandboxed */ }

  var PROTOCOL_V = 1;
  var INBOUND = {
    INIT: "vs:init",
    SET_MODE: "vs:set-mode",
    HIGHLIGHT_CHANGED: "vs:highlight-changed",
    MARK_WORKING: "vs:mark-working",
    CLEAR_WORKING: "vs:clear-working",
    SCROLL_TO: "vs:scroll-to",
  };
  var INBOUND_TYPES = new Set(Object.values(INBOUND));
  var OUT = {
    READY: "vs:ready",
    EMPTY_STATE: "vs:empty-state",
    SELECT_MODULE: "vs:select-module",
    EDIT_COMMIT: "vs:edit-commit",
    FIELD_COMMIT: "vs:field-commit",
  };

  /** Pinned on the first valid vs:init; later messages must match it. */
  var parentOrigin = null;
  var mode = "view";

  function send(type, payload) {
    if (!TOKEN) return;
    // frame-ancestors pins who may embed this doc, so window.parent is the
    // app; "*" is only used for the pre-handshake READY.
    window.parent.postMessage(
      { v: PROTOCOL_V, token: TOKEN, type: type, payload: payload },
      parentOrigin || "*"
    );
  }

  window.addEventListener("message", function (e) {
    // Only the embedding app window — never the AI page posting to itself.
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.v !== PROTOCOL_V) return;
    if (!TOKEN || typeof d.token !== "string" || d.token !== TOKEN) return;
    if (!INBOUND_TYPES.has(d.type)) return;
    if (parentOrigin === null) {
      if (d.type !== INBOUND.INIT) return; // must handshake first
      parentOrigin = e.origin;
    } else if (e.origin !== parentOrigin) {
      return;
    }
    handleCommand(d.type, d.payload || {});
  });

  function handleCommand(type, p) {
    switch (type) {
      case INBOUND.INIT:
      case INBOUND.SET_MODE:
        setMode(typeof p.mode === "string" ? p.mode : "view");
        break;
      case INBOUND.HIGHLIGHT_CHANGED:
        highlightChanged(strList(p.changed), strList(p.fresh));
        break;
      case INBOUND.MARK_WORKING:
        markWorking(strList(p.modules));
        break;
      case INBOUND.CLEAR_WORKING:
        if (Array.isArray(p.modules)) strList(p.modules).forEach(clearOneWorking);
        else clearAllWorking();
        break;
      case INBOUND.SCROLL_TO:
        if (typeof p.module === "string") scrollToModule(p.module);
        break;
    }
  }

  function strList(v) {
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string"; }) : [];
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function moduleEl(name) {
    return document.querySelector('[data-module="' + cssEscape(name) + '"]');
  }

  // ---- handshake -----------------------------------------------------------
  function onDomReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  onDomReady(function () {
    send(OUT.READY, {});
    send(OUT.EMPTY_STATE, { hasModules: !!document.querySelector("[data-module]") });
  });

  // ---- change highlighting (ported from ui/preview.js) ---------------------
  function ensureHighlightStyles() {
    if (document.getElementById("vibespot-change-highlight-css")) return;
    var style = document.createElement("style");
    style.id = "vibespot-change-highlight-css";
    style.textContent = "\n" +
      "@keyframes vibespot-change-glow{0%{outline-color:rgba(232,97,58,.85);box-shadow:0 0 0 6px rgba(232,97,58,.18)}70%{outline-color:rgba(232,97,58,.55);box-shadow:0 0 0 4px rgba(232,97,58,.1)}100%{outline-color:rgba(232,97,58,0);box-shadow:0 0 0 0 rgba(232,97,58,0)}}\n" +
      ".vibespot-module--changed{outline:2px solid rgba(232,97,58,.85);outline-offset:4px;border-radius:2px;animation:vibespot-change-glow 2s ease-out forwards}\n" +
      "@keyframes vibespot-module-slide-in{0%{opacity:0;transform:translateY(24px)}100%{opacity:1;transform:translateY(0)}}\n" +
      ".vibespot-module--new{animation:vibespot-module-slide-in .6s cubic-bezier(.2,.8,.2,1) both}\n" +
      "@media (prefers-reduced-motion:reduce){.vibespot-module--changed,.vibespot-module--new{animation:none}.vibespot-module--changed{outline-color:transparent}}";
    document.head.appendChild(style);
  }

  function highlightChanged(changed, fresh) {
    if (!changed.length && !fresh.length) return;
    ensureHighlightStyles();
    fresh.forEach(function (name) {
      var el = moduleEl(name);
      if (!el) return;
      el.classList.add("vibespot-module--new");
      setTimeout(function () { el.classList.remove("vibespot-module--new"); }, 700);
    });
    var freshSet = new Set(fresh);
    changed.forEach(function (name) {
      if (freshSet.has(name)) return; // slide-in is the stronger signal
      var el = moduleEl(name);
      if (!el) return;
      el.classList.remove("vibespot-module--changed");
      void el.offsetWidth; // restart the animation
      el.classList.add("vibespot-module--changed");
      setTimeout(function () { el.classList.remove("vibespot-module--changed"); }, 2200);
    });
  }

  function scrollToModule(name) {
    var el = moduleEl(name);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.style.outline = "2px solid #e8613a";
    el.style.outlineOffset = "4px";
    el.style.transition = "outline-color 0.5s ease";
    setTimeout(function () {
      el.style.outlineColor = "transparent";
      setTimeout(function () { el.style.outline = ""; el.style.outlineOffset = ""; }, 500);
    }, 1500);
  }

  // ---- "working on it" overlays (ported from ui/preview.js) ----------------
  var WORKING_MESSAGES = [
    "Rethinking this section…", "Rewriting the code…",
    "Giving this a fresh coat of paint…", "Making it better…",
    "Tweaking the layout…", "Polishing the details…",
    "Almost there…", "Updating the design…",
    "Improving the copy…", "Refining the structure…",
  ];
  var workingIntervals = new Map();

  function ensureOverlayStyles() {
    if (document.getElementById("vibespot-working-css")) return;
    var style = document.createElement("style");
    style.id = "vibespot-working-css";
    style.textContent = "\n" +
      ".vibespot-module--working{position:relative}\n" +
      ".vibespot-module--working > *:not(.vibespot-working-overlay){filter:blur(3px) saturate(.4);opacity:.5;transition:filter .4s ease,opacity .4s ease;pointer-events:none}\n" +
      ".vibespot-working-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;pointer-events:none}\n" +
      ".vibespot-working-overlay__spinner{width:36px;height:36px;border:3px solid rgba(232,97,58,.15);border-top-color:rgba(232,97,58,.8);border-radius:50%;animation:vw-spin .8s linear infinite;margin-bottom:12px}\n" +
      ".vibespot-working-overlay__text{font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:500;color:rgba(255,255,255,.7);text-align:center;max-width:280px;transition:opacity .5s ease}\n" +
      ".vibespot-working-overlay__text.fade{opacity:0}\n" +
      "@keyframes vw-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
  }

  function markWorking(names) {
    if (!document.body) return;
    ensureOverlayStyles();
    names.forEach(function (name, i) {
      var el = moduleEl(name);
      if (!el || el.classList.contains("vibespot-module--working")) return;
      el.classList.add("vibespot-module--working");

      var overlay = document.createElement("div");
      overlay.className = "vibespot-working-overlay";
      overlay.innerHTML =
        '<div class="vibespot-working-overlay__spinner"></div>' +
        '<div class="vibespot-working-overlay__text"></div>';
      el.appendChild(overlay);

      if (i === 0) el.scrollIntoView({ behavior: "smooth", block: "center" });

      var textEl = overlay.querySelector(".vibespot-working-overlay__text");
      var idx = Math.floor(Math.random() * WORKING_MESSAGES.length);
      textEl.textContent = WORKING_MESSAGES[idx];
      var interval = setInterval(function () {
        textEl.classList.add("fade");
        setTimeout(function () {
          idx = (idx + 1) % WORKING_MESSAGES.length;
          textEl.textContent = WORKING_MESSAGES[idx];
          textEl.classList.remove("fade");
        }, 500);
      }, 3500);
      workingIntervals.set(name, interval);
    });
  }

  function clearOneWorking(name) {
    var interval = workingIntervals.get(name);
    if (interval) { clearInterval(interval); workingIntervals.delete(name); }
    var el = moduleEl(name);
    if (!el) return;
    el.classList.remove("vibespot-module--working");
    var overlay = el.querySelector(".vibespot-working-overlay");
    if (overlay) overlay.remove();
  }

  function clearAllWorking() {
    workingIntervals.forEach(function (interval) { clearInterval(interval); });
    workingIntervals.clear();
    document.querySelectorAll(".vibespot-module--working").forEach(function (el) {
      el.classList.remove("vibespot-module--working");
      var overlay = el.querySelector(".vibespot-working-overlay");
      if (overlay) overlay.remove();
    });
  }

  // ---- interact mode (ported from ui/inline-edit.js) ------------------------
  var interactAttached = false;
  var interactState = null;

  function setMode(next) {
    if (next !== "view" && next !== "interact" && next !== "section") next = "view";
    if (next === mode) return;
    mode = next;
    if (mode === "interact") attachInteract();
    else detachInteract();
  }

  function ensureInteractStyles() {
    if (document.getElementById("vibespot-interact-css")) return;
    var style = document.createElement("style");
    style.id = "vibespot-interact-css";
    style.textContent = "\n" +
      "html.vibespot-interact-mode{cursor:default}\n" +
      ".vibespot-editable-hover{outline:2px dashed rgba(59,130,246,.6)!important;outline-offset:2px!important;cursor:text!important}\n" +
      '.vibespot-editable-hover[data-edit-type="image"]{cursor:pointer!important}\n' +
      '.vibespot-editable-hover[data-edit-type="select"]{outline-color:#e8613a!important;outline-style:solid!important;background-color:rgba(232,97,58,.08)!important;cursor:crosshair!important}\n' +
      ".vibespot-editing{outline:2px solid rgba(59,130,246,.9)!important;outline-offset:2px!important;background-color:rgba(59,130,246,.04)!important;min-height:1em}\n" +
      '.vibespot-edit-label{position:fixed;z-index:2147483647;pointer-events:none;font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;padding:2px 7px;border-radius:3px;box-shadow:0 2px 6px rgba(0,0,0,.2);white-space:nowrap}\n' +
      ".vibespot-edit-label--edit{background:#3b82f6}\n" +
      ".vibespot-edit-label--select{background:#e8613a}\n" +
      ".vibespot-image-edit-input{position:fixed;z-index:2147483647;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 10px;border:2px solid #3b82f6;border-radius:6px;background:#1c1917;color:#fff;width:320px;outline:none}\n" +
      ".vibespot-link-edit-popup{position:fixed;z-index:2147483647;background:#1c1917;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:6px}\n" +
      ".vibespot-link-edit-popup label{font:500 11px/1.4 -apple-system,sans-serif;color:rgba(255,255,255,.6)}\n" +
      ".vibespot-link-edit-popup input{font:13px/1.4 -apple-system,sans-serif;padding:5px 8px;border:1px solid rgba(255,255,255,.2);border-radius:4px;background:#0c0a09;color:#fff;outline:none;width:260px}\n" +
      ".vibespot-link-edit-popup input:focus{border-color:#3b82f6}\n" +
      ".vibespot-link-edit-popup .vibespot-link-edit-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:4px}\n" +
      ".vibespot-link-edit-popup button{font:500 12px/1 -apple-system,sans-serif;padding:5px 12px;border:none;border-radius:4px;cursor:pointer}\n" +
      ".vibespot-link-edit-popup .vibespot-btn-save{background:#3b82f6;color:#fff}\n" +
      ".vibespot-link-edit-popup .vibespot-btn-cancel{background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)}";
    document.head.appendChild(style);
  }

  function getInteractInfo(el) {
    if (!el) return null;
    var tag = (el.tagName || "").toLowerCase();

    var annotated = el.closest("[data-vs-field]");
    if (annotated) {
      var vsType = annotated.getAttribute("data-vs-type");
      if (vsType === "image") return { type: "image", el: annotated, action: "edit" };
      if (vsType === "link") return { type: "link", el: annotated, action: "edit" };
      return { type: "text", el: annotated, action: "edit" };
    }
    var linkAnnotated = el.closest("[data-vs-link]");
    if (linkAnnotated) return { type: "link", el: linkAnnotated, action: "edit" };

    if (tag === "img") return { type: "image", el: el, action: "edit" };
    if (tag === "a" || (el.closest && el.closest("a"))) {
      var anchor = tag === "a" ? el : el.closest("a");
      return { type: "link", el: anchor, action: "edit" };
    }
    if (/^h[1-6]$/.test(tag) || tag === "p" || tag === "span" || tag === "li" || tag === "td" || tag === "th") {
      if (el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === "BR")) {
        return { type: "text", el: el, action: "edit" };
      }
      if (el.textContent && el.textContent.trim().length > 0 && el.childElementCount <= 2) {
        return { type: "text", el: el, action: "edit" };
      }
    }
    if (tag === "button") return { type: "text", el: el, action: "edit" };

    var modEl = el.closest("[data-module]");
    if (modEl) return { type: "select", el: modEl, action: "select" };
    return null;
  }

  function describeElement(el) {
    if (!el) return "";
    var modEl = el.closest("[data-module]");
    var moduleName = modEl ? modEl.getAttribute("data-module") : null;
    var tag = (el.tagName || "").toLowerCase();
    var kind = tag;
    if (/^h[1-6]$/.test(tag)) kind = "headline";
    else if (tag === "p") kind = "paragraph";
    else if (tag === "a") kind = "link";
    else if (tag === "button") kind = "button";
    else if (tag === "img") kind = "image";
    else if (tag === "ul" || tag === "ol") kind = "list";
    else if (tag === "li") kind = "list item";
    if (moduleName && modEl === el) return moduleName;
    if (moduleName) return moduleName + " > " + kind;
    return kind;
  }

  function buildChatPrefill(el) {
    if (!el) return "";
    var modEl = el.closest("[data-module]");
    var moduleName = modEl ? modEl.getAttribute("data-module") : null;
    var tag = (el.tagName || "").toLowerCase();
    var text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    var elementPart;
    if (/^h[1-6]$/.test(tag)) elementPart = "the headline";
    else if (tag === "p") elementPart = "the paragraph";
    else if (tag === "a") elementPart = "the link";
    else if (tag === "button") elementPart = "the button";
    else if (tag === "img") elementPart = "the image";
    else elementPart = "the " + tag;
    if (modEl === el && moduleName) return "In the " + moduleName + " module, ";
    if (moduleName) {
      var quote = text ? ' ("' + text + (text.length === 80 ? "…" : "") + '")' : "";
      return "In the " + moduleName + " module, " + elementPart + quote + " ";
    }
    return elementPart + " ";
  }

  function attachInteract() {
    if (interactAttached || !document.body) return;
    interactAttached = true;
    ensureInteractStyles();
    document.documentElement.classList.add("vibespot-interact-mode");

    var hoveredEl = null;
    var labelEl = null;
    var activeEditor = null;

    var cleanup = function () {
      if (hoveredEl) {
        hoveredEl.classList.remove("vibespot-editable-hover");
        hoveredEl.removeAttribute("data-edit-type");
        hoveredEl = null;
      }
      if (labelEl && labelEl.parentNode) labelEl.parentNode.removeChild(labelEl);
      labelEl = null;
    };

    var closeActiveEditor = function () {
      if (!activeEditor) return;
      if (activeEditor.cleanup) activeEditor.cleanup();
      activeEditor = null;
    };

    var onMouseOver = function (e) {
      if (activeEditor) return;
      var info = getInteractInfo(e.target);
      if (!info) { cleanup(); return; }
      if (hoveredEl === info.el) return;
      cleanup();
      hoveredEl = info.el;
      hoveredEl.classList.add("vibespot-editable-hover");
      hoveredEl.setAttribute("data-edit-type", info.action === "select" ? "select" : info.type);

      if (!labelEl) {
        labelEl = document.createElement("div");
        labelEl.className = "vibespot-edit-label";
        document.body.appendChild(labelEl);
      }
      if (info.action === "select") {
        labelEl.className = "vibespot-edit-label vibespot-edit-label--select";
        labelEl.textContent = describeElement(info.el);
      } else {
        labelEl.className = "vibespot-edit-label vibespot-edit-label--edit";
        labelEl.textContent = info.type === "image" ? "Click to edit image" : info.type === "link" ? "Click to edit link" : "Click to edit";
      }
      var rect = info.el.getBoundingClientRect();
      labelEl.style.top = Math.max(4, rect.top - 20) + "px";
      labelEl.style.left = Math.max(4, rect.left) + "px";
    };

    var onMouseOut = function (e) {
      if (activeEditor) return;
      if (!e.relatedTarget) cleanup();
    };

    function startTextEdit(el, moduleName) {
      var originalText = el.textContent;
      el.setAttribute("contenteditable", "true");
      el.classList.add("vibespot-editing");
      el.focus();

      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      var save = function () {
        el.removeAttribute("contenteditable");
        el.classList.remove("vibespot-editing");
        var newText = el.textContent.trim();
        if (newText !== originalText.trim()) {
          send(OUT.EDIT_COMMIT, {
            kind: "text",
            moduleName: moduleName,
            fieldPath: el.getAttribute("data-vs-field") || null,
            originalText: originalText.trim(),
            tag: (el.tagName || "").toLowerCase(),
            value: newText,
          });
        }
        activeEditor = null;
      };

      el.addEventListener("blur", save, { once: true });
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.blur(); }
        if (e.key === "Escape") { el.textContent = originalText; el.blur(); }
      });

      activeEditor = {
        cleanup: function () {
          el.removeAttribute("contenteditable");
          el.classList.remove("vibespot-editing");
        },
      };
    }

    function startImageEdit(imgEl, moduleName) {
      var rect = imgEl.getBoundingClientRect();
      var input = document.createElement("input");
      input.className = "vibespot-image-edit-input";
      input.type = "text";
      input.placeholder = "Enter image URL...";
      input.value = imgEl.src || "";
      input.style.top = rect.bottom + 4 + "px";
      input.style.left = Math.max(4, rect.left) + "px";
      document.body.appendChild(input);
      input.focus();
      input.select();

      var save = function () {
        var newSrc = input.value.trim();
        if (input.parentNode) input.parentNode.removeChild(input);
        if (newSrc && newSrc !== imgEl.src) {
          var oldSrc = imgEl.src || "";
          imgEl.src = newSrc; // optimistic in-frame update
          send(OUT.EDIT_COMMIT, {
            kind: "image",
            moduleName: moduleName,
            fieldPath: imgEl.getAttribute("data-vs-field") || null,
            alt: imgEl.getAttribute("alt") || "",
            oldSrc: oldSrc,
            value: newSrc,
          });
        }
        activeEditor = null;
      };

      input.addEventListener("blur", save, { once: true });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") {
          if (input.parentNode) input.parentNode.removeChild(input);
          activeEditor = null;
        }
      });

      activeEditor = {
        cleanup: function () { if (input.parentNode) input.parentNode.removeChild(input); },
      };
    }

    function startLinkEdit(anchorEl, moduleName) {
      var origText = (anchorEl.textContent || "").trim();
      var origHref = anchorEl.href || "";
      var rect = anchorEl.getBoundingClientRect();

      var popup = document.createElement("div");
      popup.className = "vibespot-link-edit-popup";
      popup.style.top = rect.bottom + 6 + "px";
      popup.style.left = Math.max(4, rect.left) + "px";

      var textLabel = document.createElement("label");
      textLabel.textContent = "Link text";
      var textInput = document.createElement("input");
      textInput.type = "text";
      textInput.value = origText;

      var urlLabel = document.createElement("label");
      urlLabel.textContent = "URL";
      var urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.value = origHref;

      var actions = document.createElement("div");
      actions.className = "vibespot-link-edit-actions";
      var cancelBtn = document.createElement("button");
      cancelBtn.className = "vibespot-btn-cancel";
      cancelBtn.textContent = "Cancel";
      var saveBtn = document.createElement("button");
      saveBtn.className = "vibespot-btn-save";
      saveBtn.textContent = "Save";
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);

      popup.appendChild(textLabel);
      popup.appendChild(textInput);
      popup.appendChild(urlLabel);
      popup.appendChild(urlInput);
      popup.appendChild(actions);
      document.body.appendChild(popup);
      textInput.focus();

      var close = function () {
        if (popup.parentNode) popup.parentNode.removeChild(popup);
        activeEditor = null;
      };

      cancelBtn.addEventListener("click", close);
      saveBtn.addEventListener("click", function () {
        var newText = textInput.value.trim();
        var newUrl = urlInput.value.trim();
        if (newText) anchorEl.textContent = newText;
        if (newUrl) anchorEl.href = newUrl;
        if (newText !== origText || newUrl !== origHref) {
          send(OUT.EDIT_COMMIT, {
            kind: "link",
            moduleName: moduleName,
            linkField: anchorEl.getAttribute("data-vs-link") || null,
            textField: anchorEl.getAttribute("data-vs-field") || null,
            origText: origText,
            origHref: origHref,
            newText: newText,
            newUrl: newUrl,
          });
        }
        close();
      });

      popup.addEventListener("keydown", function (e) {
        if (e.key === "Escape") close();
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
      });

      activeEditor = { cleanup: close };
    }

    var onClick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      var info = getInteractInfo(e.target);
      if (!info) return;

      closeActiveEditor();
      cleanup();

      if (info.action === "select") {
        send(OUT.SELECT_MODULE, {
          module: info.el.getAttribute("data-module") || "",
          prefill: buildChatPrefill(info.el),
        });
        return;
      }

      var modEl = info.el.closest("[data-module]");
      if (!modEl) return;
      var moduleName = modEl.getAttribute("data-module");

      if (info.type === "text") startTextEdit(info.el, moduleName);
      else if (info.type === "image") startImageEdit(info.el, moduleName);
      else if (info.type === "link") startLinkEdit(info.el, moduleName);
    };

    var onKeyDown = function (e) {
      // Escape closes any open editor; leaving interact mode is the parent
      // toolbar button's job (no preview->parent verb widens for it).
      if (e.key === "Escape") closeActiveEditor();
    };

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    interactState = {
      onMouseOver: onMouseOver,
      onMouseOut: onMouseOut,
      onClick: onClick,
      onKeyDown: onKeyDown,
      cleanup: cleanup,
      closeActiveEditor: closeActiveEditor,
    };
  }

  function detachInteract() {
    if (!interactAttached || !interactState) { interactAttached = false; return; }
    interactState.closeActiveEditor();
    interactState.cleanup();
    document.documentElement.classList.remove("vibespot-interact-mode");
    document.removeEventListener("mouseover", interactState.onMouseOver, true);
    document.removeEventListener("mouseout", interactState.onMouseOut, true);
    document.removeEventListener("click", interactState.onClick, true);
    document.removeEventListener("keydown", interactState.onKeyDown, true);
    interactState = null;
    interactAttached = false;
  }

  // ---- section controls (ported from ui/section-controls.js) ---------------
  (function sectionControls() {
    var activeToolbar = null;
    var activeModule = null;
    var activePopover = null;
    var hideTimer = null;
    var updateTimer = null;
    var interacting = false;
    var pendingUpdate = null;

    onDomReady(function () {
      if (!document.body) return;
      ensureSectionStyles();

      document.addEventListener("mouseover", function (e) {
        if (mode === "interact") return; // inline editing owns the pointer
        if (interacting) return;
        var modEl = e.target.closest("[data-module]");
        if (!modEl) return;
        if (modEl === activeModule) { clearTimeout(hideTimer); return; }
        clearTimeout(hideTimer);
        showToolbar(modEl);
      }, true);

      document.addEventListener("mouseout", function (e) {
        if (!activeToolbar || interacting) return;
        var related = e.relatedTarget;
        if (related) {
          if (activeToolbar.contains(related)) return;
          if (activeModule && activeModule.contains(related)) return;
          if (activePopover && activePopover.contains(related)) return;
        }
        hideTimer = setTimeout(hideToolbar, 250);
      }, true);

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && activePopover) closePopover();
      }, true);
    });

    function showToolbar(modEl) {
      hideToolbar();
      var moduleName = modEl.getAttribute("data-module");
      if (!moduleName) return;
      var fields = FIELDS[moduleName];
      if (!Array.isArray(fields)) return;
      activeModule = modEl;

      var controls = categorizeFields(fields, "");
      if (!controls.length) return;

      var toolbar = document.createElement("div");
      toolbar.className = "vs-sc-toolbar";
      controls.forEach(function (ctrl) {
        toolbar.appendChild(createControl(ctrl, moduleName));
      });

      var computed = window.getComputedStyle(modEl);
      if (computed.position === "static") modEl.style.position = "relative";
      modEl.appendChild(toolbar);
      activeToolbar = toolbar;

      toolbar.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
      toolbar.addEventListener("mouseleave", function (e) {
        if (interacting) return;
        if (activeModule && activeModule.contains(e.relatedTarget)) return;
        if (activePopover && activePopover.contains(e.relatedTarget)) return;
        hideTimer = setTimeout(hideToolbar, 250);
      });
    }

    function hideToolbar() {
      if (interacting) return;
      closePopover();
      if (activeToolbar && activeToolbar.parentNode) activeToolbar.parentNode.removeChild(activeToolbar);
      activeToolbar = null;
      activeModule = null;
    }

    function categorizeFields(fields, prefix) {
      var controls = [];
      fields.forEach(function (field) {
        if (!field || typeof field !== "object") return;
        var path = prefix ? prefix + "." + field.name : field.name;
        if (field.type === "group" && field.children) {
          controls.push.apply(controls, categorizeFields(field.children, path));
          return;
        }
        var n = String(field.name || "").toLowerCase();
        if (field.type === "color") controls.push({ kind: "color", field: field, path: path, label: field.label || field.name });
        else if (field.type === "image") controls.push({ kind: "image", field: field, path: path, label: field.label || field.name });
        else if (field.type === "number" && /padding|margin|spacing/i.test(n)) controls.push({ kind: "spacing", field: field, path: path, label: field.label || field.name });
        else if (field.type === "number" && /font.?size|text.?size/i.test(n)) controls.push({ kind: "fontsize", field: field, path: path, label: field.label || field.name });
      });
      return controls;
    }

    function shortLabel(label) {
      label = String(label || "");
      return label.length <= 12 ? label : label.slice(0, 10) + "…";
    }

    function createControl(ctrl, moduleName) {
      var btn = document.createElement("button");
      btn.className = "vs-sc-btn";
      btn.setAttribute("data-kind", ctrl.kind);
      btn.title = ctrl.label;

      switch (ctrl.kind) {
        case "color": {
          var swatch = document.createElement("span");
          swatch.className = "vs-sc-swatch";
          swatch.style.background = (ctrl.field.default && ctrl.field.default.color) || "#888";
          btn.appendChild(swatch);
          var lbl = document.createElement("span");
          lbl.className = "vs-sc-label";
          lbl.textContent = shortLabel(ctrl.label);
          btn.appendChild(lbl);
          break;
        }
        case "spacing":
          btn.innerHTML =
            '<svg class="vs-sc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18M7 8l5-5 5 5M7 16l5 5 5-5"/></svg>' +
            '<span class="vs-sc-label">' + (ctrl.field.default != null ? ctrl.field.default : 0) + "px</span>";
          break;
        case "image":
          btn.innerHTML =
            '<svg class="vs-sc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' +
            '<span class="vs-sc-label">' + shortLabel(ctrl.label) + "</span>";
          break;
        case "fontsize":
          btn.innerHTML =
            '<span class="vs-sc-icon" style="font-weight:600;font-size:11px">Aa</span>' +
            '<span class="vs-sc-label">' + (ctrl.field.default != null ? ctrl.field.default : 16) + "px</span>";
          break;
      }

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openPopover(btn, ctrl, moduleName);
      });
      return btn;
    }

    function openPopover(anchor, ctrl, moduleName) {
      closePopover();
      interacting = true;

      var pop = document.createElement("div");
      pop.className = "vs-sc-popover";

      switch (ctrl.kind) {
        case "color": buildColorPopover(pop, anchor, ctrl, moduleName); break;
        case "spacing": buildSliderPopover(pop, anchor, ctrl, moduleName, 0, 120, 0, true); break;
        case "image": buildImagePopover(pop, ctrl, moduleName); break;
        case "fontsize": buildSliderPopover(pop, anchor, ctrl, moduleName, 8, 96, 16, false); break;
      }

      var rect = anchor.getBoundingClientRect();
      pop.style.top = rect.bottom + 6 + "px";
      pop.style.left = Math.max(4, rect.left) + "px";
      document.body.appendChild(pop);
      activePopover = pop;

      pop.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
      pop.addEventListener("mouseleave", function (e) {
        if (activeToolbar && activeToolbar.contains(e.relatedTarget)) return;
        if (activeModule && activeModule.contains(e.relatedTarget)) return;
        closePopover();
      });
    }

    function closePopover() {
      if (activePopover && activePopover.parentNode) activePopover.parentNode.removeChild(activePopover);
      activePopover = null;
      if (interacting) {
        interacting = false;
        flushUpdate(true);
      }
    }

    function buildColorPopover(pop, anchor, ctrl, moduleName) {
      var picker = document.createElement("input");
      picker.type = "color";
      picker.className = "vs-sc-color-picker";
      picker.value = (ctrl.field.default && ctrl.field.default.color) || "#000000";

      var hex = document.createElement("input");
      hex.type = "text";
      hex.className = "vs-sc-hex";
      hex.value = picker.value;

      var row = document.createElement("div");
      row.className = "vs-sc-color-row";
      row.appendChild(picker);
      row.appendChild(hex);
      pop.appendChild(row);

      var apply = function (color) {
        var swatch = anchor.querySelector(".vs-sc-swatch");
        if (swatch) swatch.style.background = color;
        queueUpdate(moduleName, ctrl.path, {
          color: color,
          opacity: (ctrl.field.default && ctrl.field.default.opacity) != null ? ctrl.field.default.opacity : 100,
        });
      };

      picker.addEventListener("input", function () {
        hex.value = picker.value;
        apply(picker.value);
      });
      hex.addEventListener("change", function () {
        if (/^#[0-9a-f]{3,8}$/i.test(hex.value)) {
          picker.value = hex.value.length === 4
            ? "#" + hex.value[1] + hex.value[1] + hex.value[2] + hex.value[2] + hex.value[3] + hex.value[3]
            : hex.value;
          apply(hex.value);
        }
      });
    }

    function buildSliderPopover(pop, anchor, ctrl, moduleName, min, max, fallback, withLabel) {
      if (withLabel) {
        var lbl = document.createElement("div");
        lbl.className = "vs-sc-pop-label";
        lbl.textContent = ctrl.label;
        pop.appendChild(lbl);
      }
      var row = document.createElement("div");
      row.className = "vs-sc-slider-row";

      var slider = document.createElement("input");
      slider.type = "range";
      slider.className = "vs-sc-slider";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = "1";
      slider.value = ctrl.field.default != null ? ctrl.field.default : fallback;

      var val = document.createElement("span");
      val.className = "vs-sc-slider-val";
      val.textContent = slider.value + "px";

      slider.addEventListener("input", function () {
        val.textContent = slider.value + "px";
        var btnLabel = anchor.querySelector(".vs-sc-label");
        if (btnLabel) btnLabel.textContent = slider.value + "px";
        queueUpdate(moduleName, ctrl.path, Number(slider.value));
      });

      row.appendChild(slider);
      row.appendChild(val);
      pop.appendChild(row);
    }

    function buildImagePopover(pop, ctrl, moduleName) {
      var lbl = document.createElement("div");
      lbl.className = "vs-sc-pop-label";
      lbl.textContent = ctrl.label;

      var input = document.createElement("input");
      input.type = "text";
      input.className = "vs-sc-url-input";
      input.placeholder = "Enter image URL…";
      input.value = (ctrl.field.default && ctrl.field.default.src) || "";

      var btn = document.createElement("button");
      btn.className = "vs-sc-apply-btn";
      btn.textContent = "Apply";

      btn.addEventListener("click", function () {
        var src = input.value.trim();
        if (src) {
          queueUpdate(moduleName, ctrl.path, {
            src: src,
            alt: (ctrl.field.default && ctrl.field.default.alt) || "",
          });
          closePopover();
        }
      });

      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); btn.click(); }
        if (e.key === "Escape") closePopover();
      });

      pop.appendChild(lbl);
      pop.appendChild(input);
      pop.appendChild(btn);
      input.focus();
    }

    function queueUpdate(moduleName, fieldPath, value) {
      pendingUpdate = { moduleName: moduleName, fieldPath: fieldPath, value: value };
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function () { flushUpdate(false); }, 300);
    }

    function flushUpdate(popoverClosed) {
      clearTimeout(updateTimer);
      var upd = pendingUpdate;
      if (!upd) return;
      pendingUpdate = null;
      send(OUT.FIELD_COMMIT, {
        moduleName: upd.moduleName,
        fieldPath: upd.fieldPath,
        value: upd.value,
        // While the popover is open the user is still dragging — the parent
        // persists but defers the reload so the controls don't vanish.
        refresh: popoverClosed || !interacting,
      });
    }

    function ensureSectionStyles() {
      if (document.getElementById("vs-section-controls-css")) return;
      var s = document.createElement("style");
      s.id = "vs-section-controls-css";
      s.textContent = "\n" +
        '.vs-sc-toolbar{position:absolute;top:8px;right:8px;z-index:10000;display:flex;align-items:center;gap:2px;background:rgba(15,13,12,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:3px;box-shadow:0 4px 16px rgba(0,0,0,.35);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;animation:vs-sc-fadein .15s ease;pointer-events:auto}\n' +
        "@keyframes vs-sc-fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}\n" +
        ".vs-sc-btn{display:flex;align-items:center;gap:4px;padding:4px 8px;background:transparent;border:none;border-radius:5px;color:rgba(255,255,255,.8);font:500 11px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s}\n" +
        ".vs-sc-btn:hover{background:rgba(255,255,255,.1);color:#fff}\n" +
        ".vs-sc-swatch{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid rgba(255,255,255,.25);flex-shrink:0}\n" +
        ".vs-sc-icon{flex-shrink:0;opacity:.7}\n" +
        ".vs-sc-label{max-width:72px;overflow:hidden;text-overflow:ellipsis}\n" +
        '.vs-sc-popover{position:fixed;z-index:10001;background:rgba(15,13,12,.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.45);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;animation:vs-sc-fadein .12s ease;min-width:180px}\n' +
        ".vs-sc-pop-label{font:500 11px/1.4 -apple-system,sans-serif;color:rgba(255,255,255,.5);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}\n" +
        ".vs-sc-color-row{display:flex;align-items:center;gap:8px}\n" +
        ".vs-sc-color-picker{width:36px;height:28px;border:none;border-radius:4px;padding:0;cursor:pointer;background:transparent}\n" +
        ".vs-sc-color-picker::-webkit-color-swatch-wrapper{padding:0}\n" +
        ".vs-sc-color-picker::-webkit-color-swatch{border:1px solid rgba(255,255,255,.2);border-radius:4px}\n" +
        ".vs-sc-color-picker::-moz-color-swatch{border:1px solid rgba(255,255,255,.2);border-radius:4px}\n" +
        ".vs-sc-hex{flex:1;font:12px/1.4 -apple-system,sans-serif;padding:4px 6px;border:1px solid rgba(255,255,255,.15);border-radius:4px;background:rgba(0,0,0,.3);color:#fff;outline:none;width:80px}\n" +
        ".vs-sc-hex:focus{border-color:#e8613a}\n" +
        ".vs-sc-slider-row{display:flex;align-items:center;gap:8px}\n" +
        ".vs-sc-slider{flex:1;height:4px;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,.15);border-radius:2px;outline:none;cursor:pointer}\n" +
        ".vs-sc-slider::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#e8613a;border:2px solid #fff;cursor:pointer}\n" +
        ".vs-sc-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#e8613a;border:2px solid #fff;cursor:pointer}\n" +
        ".vs-sc-slider-val{font:500 12px/1 -apple-system,sans-serif;color:rgba(255,255,255,.7);min-width:36px;text-align:right}\n" +
        ".vs-sc-url-input{width:100%;font:12px/1.4 -apple-system,sans-serif;padding:6px 8px;border:1px solid rgba(255,255,255,.15);border-radius:5px;background:rgba(0,0,0,.3);color:#fff;outline:none;margin-bottom:6px;box-sizing:border-box}\n" +
        ".vs-sc-url-input:focus{border-color:#e8613a}\n" +
        ".vs-sc-apply-btn{display:block;width:100%;font:500 12px/1 -apple-system,sans-serif;padding:6px 12px;border:none;border-radius:5px;background:#e8613a;color:#fff;cursor:pointer;transition:background .15s}\n" +
        ".vs-sc-apply-btn:hover{background:#d4522e}\n" +
        "@media (prefers-reduced-motion:reduce){.vs-sc-toolbar,.vs-sc-popover{animation:none}}";
      document.head.appendChild(s);
    }
  })();
})();
