/**
 * Unified interact mode — merged Select + Edit into one contextual model.
 *
 * Editable elements (text, images, links) get inline editing.
 * Module-level containers prefill the chat input for referencing.
 */

const interactBtn = document.getElementById("interact-mode-toggle");
let interactModeActive = false;
let interactHandlers = null;

function ensureInteractStyles(doc) {
  if (doc.getElementById("vibespot-interact-css")) return;
  const style = doc.createElement("style");
  style.id = "vibespot-interact-css";
  style.textContent = `
    html.vibespot-interact-mode { cursor: default; }
    .vibespot-editable-hover {
      outline: 2px dashed rgba(59, 130, 246, 0.6) !important;
      outline-offset: 2px !important;
      cursor: text !important;
    }
    .vibespot-editable-hover[data-edit-type="image"] {
      cursor: pointer !important;
    }
    .vibespot-editable-hover[data-edit-type="select"] {
      outline-color: #e8613a !important;
      outline-style: solid !important;
      background-color: rgba(232, 97, 58, 0.08) !important;
      cursor: crosshair !important;
    }
    .vibespot-editing {
      outline: 2px solid rgba(59, 130, 246, 0.9) !important;
      outline-offset: 2px !important;
      background-color: rgba(59, 130, 246, 0.04) !important;
      min-height: 1em;
    }
    .vibespot-edit-label {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      font: 500 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      padding: 2px 7px;
      border-radius: 3px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      white-space: nowrap;
    }
    .vibespot-edit-label--edit {
      background: #3b82f6;
    }
    .vibespot-edit-label--select {
      background: #e8613a;
    }
    .vibespot-image-edit-input {
      position: fixed;
      z-index: 2147483647;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 6px 10px;
      border: 2px solid #3b82f6;
      border-radius: 6px;
      background: #1c1917;
      color: #fff;
      width: 320px;
      outline: none;
    }
    .vibespot-link-edit-popup {
      position: fixed;
      z-index: 2147483647;
      background: #1c1917;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .vibespot-link-edit-popup label {
      font: 500 11px/1.4 -apple-system, sans-serif;
      color: rgba(255,255,255,0.6);
    }
    .vibespot-link-edit-popup input {
      font: 13px/1.4 -apple-system, sans-serif;
      padding: 5px 8px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px;
      background: #0c0a09;
      color: #fff;
      outline: none;
      width: 260px;
    }
    .vibespot-link-edit-popup input:focus { border-color: #3b82f6; }
    .vibespot-link-edit-popup .vibespot-link-edit-actions {
      display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;
    }
    .vibespot-link-edit-popup button {
      font: 500 12px/1 -apple-system, sans-serif;
      padding: 5px 12px;
      border: none; border-radius: 4px;
      cursor: pointer;
    }
    .vibespot-link-edit-popup .vibespot-btn-save {
      background: #3b82f6; color: #fff;
    }
    .vibespot-link-edit-popup .vibespot-btn-cancel {
      background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7);
    }
  `;
  doc.head.appendChild(style);
}

// Determine if element is directly editable (text/image/link) or module-level
function getInteractInfo(el) {
  if (!el) return null;
  const tag = (el.tagName || "").toLowerCase();

  // Check for explicit field annotations first
  const annotated = el.closest("[data-vs-field]");
  if (annotated) {
    const vsType = annotated.getAttribute("data-vs-type");
    if (vsType === "image") return { type: "image", el: annotated, action: "edit" };
    if (vsType === "link") return { type: "link", el: annotated, action: "edit" };
    return { type: "text", el: annotated, action: "edit" };
  }
  const linkAnnotated = el.closest("[data-vs-link]");
  if (linkAnnotated) return { type: "link", el: linkAnnotated, action: "edit" };

  // Heuristic detection for editable elements
  if (tag === "img") return { type: "image", el, action: "edit" };
  if (tag === "a" || (el.closest && el.closest("a"))) {
    const anchor = tag === "a" ? el : el.closest("a");
    return { type: "link", el: anchor, action: "edit" };
  }
  if (tag.match(/^h[1-6]$/) || tag === "p" || tag === "span" || tag === "li" || tag === "td" || tag === "th") {
    if (el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === "BR")) {
      return { type: "text", el, action: "edit" };
    }
    if (el.textContent && el.textContent.trim().length > 0 && el.childElementCount <= 2) {
      return { type: "text", el, action: "edit" };
    }
  }
  if (tag === "button") return { type: "text", el, action: "edit" };

  // Module-level container → select mode (prefill chat)
  const moduleEl = el.closest("[data-module]");
  if (moduleEl) return { type: "select", el: moduleEl, action: "select" };

  return null;
}

function describeElement(el) {
  if (!el) return "";
  const moduleEl = el.closest("[data-module]");
  const moduleName = moduleEl ? moduleEl.getAttribute("data-module") : null;
  const tag = (el.tagName || "").toLowerCase();
  let kind = tag;
  if (tag.match(/^h[1-6]$/)) kind = "headline";
  else if (tag === "p") kind = "paragraph";
  else if (tag === "a") kind = "link";
  else if (tag === "button") kind = "button";
  else if (tag === "img") kind = "image";
  else if (tag === "ul" || tag === "ol") kind = "list";
  else if (tag === "li") kind = "list item";

  if (moduleName && moduleEl === el) return moduleName;
  if (moduleName) return `${moduleName} > ${kind}`;
  return kind;
}

function buildChatPrefill(el) {
  if (!el) return "";
  const moduleEl = el.closest("[data-module]");
  const moduleName = moduleEl ? moduleEl.getAttribute("data-module") : null;
  const tag = (el.tagName || "").toLowerCase();
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);

  let elementPart;
  if (tag.match(/^h[1-6]$/)) elementPart = "the headline";
  else if (tag === "p") elementPart = "the paragraph";
  else if (tag === "a") elementPart = "the link";
  else if (tag === "button") elementPart = "the button";
  else if (tag === "img") elementPart = "the image";
  else elementPart = `the ${tag}`;

  if (moduleEl === el && moduleName) {
    return `In the ${moduleName} section, `;
  }
  if (moduleName) {
    const quote = text ? ` ("${text}${text.length === 80 ? "…" : ""}")` : "";
    return `In the ${moduleName} section, ${elementPart}${quote} `;
  }
  return `${elementPart} `;
}

function attachInteractHandlers() {
  let doc;
  try {
    doc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
  } catch { return; }
  if (!doc || !doc.body) return;

  ensureInteractStyles(doc);
  doc.documentElement.classList.add("vibespot-interact-mode");

  let hoveredEl = null;
  let labelEl = null;
  let activeEditor = null;

  const cleanup = () => {
    if (hoveredEl) {
      hoveredEl.classList.remove("vibespot-editable-hover", "vibespot-select-hover");
      hoveredEl.removeAttribute("data-edit-type");
      hoveredEl = null;
    }
    if (labelEl && labelEl.parentNode) {
      labelEl.parentNode.removeChild(labelEl);
    }
    labelEl = null;
  };

  const onMouseOver = (e) => {
    if (activeEditor) return;
    const info = getInteractInfo(e.target);
    if (!info) {
      cleanup();
      return;
    }
    if (hoveredEl === info.el) return;
    cleanup();
    hoveredEl = info.el;
    hoveredEl.classList.add("vibespot-editable-hover");
    hoveredEl.setAttribute("data-edit-type", info.action === "select" ? "select" : info.type);

    if (!labelEl) {
      labelEl = doc.createElement("div");
      labelEl.className = "vibespot-edit-label";
      doc.body.appendChild(labelEl);
    }

    if (info.action === "select") {
      labelEl.className = "vibespot-edit-label vibespot-edit-label--select";
      labelEl.textContent = describeElement(info.el);
    } else {
      labelEl.className = "vibespot-edit-label vibespot-edit-label--edit";
      const typeLabel = info.type === "image" ? "Click to edit image" : info.type === "link" ? "Click to edit link" : "Click to edit";
      labelEl.textContent = typeLabel;
    }
    const rect = info.el.getBoundingClientRect();
    labelEl.style.top = Math.max(4, rect.top - 20) + "px";
    labelEl.style.left = Math.max(4, rect.left) + "px";
  };

  const onMouseOut = (e) => {
    if (activeEditor) return;
    if (!e.relatedTarget) cleanup();
  };

  const closeActiveEditor = () => {
    if (!activeEditor) return;
    if (activeEditor.cleanup) activeEditor.cleanup();
    activeEditor = null;
  };

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const info = getInteractInfo(e.target);
    if (!info) return;

    closeActiveEditor();
    cleanup();

    if (info.action === "select") {
      const prefill = buildChatPrefill(info.el);
      if (typeof window.prefillChatInput === "function") {
        window.prefillChatInput(prefill);
      }
      return;
    }

    const moduleEl = info.el.closest("[data-module]");
    if (!moduleEl) return;
    const moduleName = moduleEl.getAttribute("data-module");

    if (info.type === "text") {
      startTextEdit(doc, info.el, moduleName);
    } else if (info.type === "image") {
      startImageEdit(doc, info.el, moduleName);
    } else if (info.type === "link") {
      startLinkEdit(doc, info.el, moduleName);
    }
  };

  function startTextEdit(doc, el, moduleName) {
    const originalText = el.textContent;
    el.setAttribute("data-original-text", originalText.trim());
    el.setAttribute("contenteditable", "true");
    el.classList.add("vibespot-editing");
    el.focus();

    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const save = () => {
      el.removeAttribute("contenteditable");
      el.classList.remove("vibespot-editing");
      const newText = el.textContent.trim();
      if (newText !== originalText.trim()) {
        saveTextChange(moduleName, el, newText);
      }
      activeEditor = null;
    };

    el.addEventListener("blur", save, { once: true });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      }
      if (e.key === "Escape") {
        el.textContent = originalText;
        el.blur();
      }
    });

    activeEditor = {
      cleanup: () => {
        el.removeAttribute("contenteditable");
        el.classList.remove("vibespot-editing");
      },
    };
  }

  function startImageEdit(doc, imgEl, moduleName) {
    const rect = imgEl.getBoundingClientRect();
    const input = doc.createElement("input");
    input.className = "vibespot-image-edit-input";
    input.type = "text";
    input.placeholder = "Enter image URL...";
    input.value = imgEl.src || "";
    input.style.top = (rect.bottom + 4) + "px";
    input.style.left = Math.max(4, rect.left) + "px";
    doc.body.appendChild(input);
    input.focus();
    input.select();

    const save = () => {
      const newSrc = input.value.trim();
      if (input.parentNode) input.parentNode.removeChild(input);
      if (newSrc && newSrc !== imgEl.src) {
        imgEl.src = newSrc;
        saveImageChange(moduleName, imgEl, newSrc);
      }
      activeEditor = null;
    };

    input.addEventListener("blur", save, { once: true });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") {
        if (input.parentNode) input.parentNode.removeChild(input);
        activeEditor = null;
      }
    });

    activeEditor = {
      cleanup: () => { if (input.parentNode) input.parentNode.removeChild(input); },
    };
  }

  function startLinkEdit(doc, anchorEl, moduleName) {
    const origText = (anchorEl.textContent || "").trim();
    const origHref = anchorEl.href || "";
    const rect = anchorEl.getBoundingClientRect();

    const popup = doc.createElement("div");
    popup.className = "vibespot-link-edit-popup";
    popup.style.top = (rect.bottom + 6) + "px";
    popup.style.left = Math.max(4, rect.left) + "px";

    const textLabel = doc.createElement("label");
    textLabel.textContent = "Link text";
    const textInput = doc.createElement("input");
    textInput.type = "text";
    textInput.className = "vibespot-link-text";
    textInput.value = origText;

    const urlLabel = doc.createElement("label");
    urlLabel.textContent = "URL";
    const urlInput = doc.createElement("input");
    urlInput.type = "text";
    urlInput.className = "vibespot-link-url";
    urlInput.value = origHref;

    const actions = doc.createElement("div");
    actions.className = "vibespot-link-edit-actions";
    const cancelBtn = doc.createElement("button");
    cancelBtn.className = "vibespot-btn-cancel";
    cancelBtn.textContent = "Cancel";
    const saveBtn = doc.createElement("button");
    saveBtn.className = "vibespot-btn-save";
    saveBtn.textContent = "Save";
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    popup.appendChild(textLabel);
    popup.appendChild(textInput);
    popup.appendChild(urlLabel);
    popup.appendChild(urlInput);
    popup.appendChild(actions);
    doc.body.appendChild(popup);
    textInput.focus();

    const close = () => {
      if (popup.parentNode) popup.parentNode.removeChild(popup);
      activeEditor = null;
    };

    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", () => {
      const newText = textInput.value.trim();
      const newUrl = urlInput.value.trim();
      if (newText) anchorEl.textContent = newText;
      if (newUrl) anchorEl.href = newUrl;
      if (newText !== origText || newUrl !== origHref) {
        saveLinkChange(moduleName, anchorEl, newText, newUrl);
      }
      close();
    });

    popup.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn.click();
      }
    });

    activeEditor = { cleanup: close };
  }

  const onKeyDown = (e) => {
    if (e.key === "Escape" && !activeEditor) deactivateInteractMode();
  };

  doc.addEventListener("mouseover", onMouseOver, true);
  doc.addEventListener("mouseout", onMouseOut, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeyDown, true);

  interactHandlers = {
    doc,
    onMouseOver,
    onMouseOut,
    onClick,
    onKeyDown,
    cleanup,
    closeActiveEditor,
  };
}

function detachInteractHandlers() {
  if (!interactHandlers) return;
  const { doc, onMouseOver, onMouseOut, onClick, onKeyDown, cleanup, closeActiveEditor } = interactHandlers;
  try {
    closeActiveEditor();
    cleanup();
    doc.documentElement.classList.remove("vibespot-interact-mode");
    doc.removeEventListener("mouseover", onMouseOver, true);
    doc.removeEventListener("mouseout", onMouseOut, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  } catch { /* cross-origin */ }
  interactHandlers = null;
}

function activateInteractMode() {
  if (interactModeActive) return;
  interactModeActive = true;
  if (interactBtn) interactBtn.setAttribute("aria-pressed", "true");
  const previewContainer = document.getElementById("preview-container");
  if (previewContainer) previewContainer.classList.add("preview--interact-mode");
  attachInteractHandlers();
}

function deactivateInteractMode() {
  if (!interactModeActive) return;
  interactModeActive = false;
  if (interactBtn) interactBtn.setAttribute("aria-pressed", "false");
  const previewContainer = document.getElementById("preview-container");
  if (previewContainer) previewContainer.classList.remove("preview--interact-mode");
  detachInteractHandlers();
}

function setInteractModeDisabled(disabled) {
  if (!interactBtn) return;
  if (disabled) {
    deactivateInteractMode();
    interactBtn.disabled = true;
  } else {
    interactBtn.disabled = false;
  }
}

if (interactBtn) {
  interactBtn.addEventListener("click", () => {
    if (interactBtn.disabled) return;
    if (interactModeActive) deactivateInteractMode();
    else activateInteractMode();
  });
}

if (typeof previewFrame !== "undefined" && previewFrame) {
  previewFrame.addEventListener("load", () => {
    if (interactModeActive) attachInteractHandlers();
  });
}

// Backward-compat aliases
window.setEditModeDisabled = setInteractModeDisabled;
window.deactivateEditMode = deactivateInteractMode;
window.setSelectModeDisabled = setInteractModeDisabled;
window.deactivateSelectMode = deactivateInteractMode;

// ---------------------------------------------------------------------------
// Save helpers — find matching field in fields.json and update via /api/field
// ---------------------------------------------------------------------------

async function findModuleFields(moduleName) {
  try {
    const res = await fetch("/api/modules");
    const data = await res.json();
    const mod = data.modules.find((m) => m.moduleName === moduleName);
    if (!mod) return null;
    return { fields: JSON.parse(mod.fieldsJson), moduleName };
  } catch { return null; }
}

function findFieldByText(fields, originalText, tag, prefix = "") {
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;

    if (field.type === "group" && field.children) {
      const found = findFieldByText(field.children, originalText, tag, path);
      if (found) return found;
      continue;
    }

    const val = typeof field.default === "string" ? field.default : "";
    const stripped = val.replace(/<[^>]*>/g, "").trim();
    if (stripped && originalText && stripped === originalText) {
      return { path, field, isHtml: val !== stripped };
    }
  }
  return null;
}

function findImageField(fields, imgSrc, prefix = "") {
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (field.type === "group" && field.children) {
      const found = findImageField(field.children, imgSrc, path);
      if (found) return found;
    }
    if (field.type === "image" && field.default?.src) {
      return { path, field };
    }
  }
  return null;
}

function findLinkField(fields, href, prefix = "") {
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (field.type === "group" && field.children) {
      const found = findLinkField(field.children, href, path);
      if (found) return found;
    }
    if (field.type === "link") return { path, field };
  }
  return null;
}

async function saveTextChange(moduleName, el, newText) {
  const fieldPath = el.getAttribute("data-vs-field");
  if (fieldPath) {
    await fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleName, fieldPath, value: newText }),
    });
    refreshPreview();
    return;
  }

  const data = await findModuleFields(moduleName);
  if (!data) { refreshPreview(); return; }

  const originalText = el.getAttribute("data-original-text") || newText;
  const match = findFieldByText(data.fields, originalText, el.tagName.toLowerCase());

  if (match) {
    await fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleName, fieldPath: match.path, value: newText }),
    });
  }
  refreshPreview();
}

async function saveImageChange(moduleName, imgEl, newSrc) {
  const fieldPath = imgEl.getAttribute("data-vs-field");
  if (fieldPath) {
    await fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleName,
        fieldPath,
        value: { src: newSrc, alt: imgEl.getAttribute("alt") || "" },
      }),
    });
    refreshPreview();
    return;
  }

  const data = await findModuleFields(moduleName);
  if (!data) { refreshPreview(); return; }

  const match = findImageField(data.fields, imgEl.src);
  if (match) {
    await fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleName,
        fieldPath: match.path,
        value: { src: newSrc, alt: match.field.default?.alt || "" },
      }),
    });
  }
  refreshPreview();
}

async function saveLinkChange(moduleName, anchorEl, newText, newUrl) {
  const linkField = anchorEl.getAttribute("data-vs-link");
  const textField = anchorEl.getAttribute("data-vs-field");

  if (linkField || textField) {
    if (linkField && newUrl) {
      await fetch("/api/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleName,
          fieldPath: linkField,
          value: { url: { href: newUrl, type: "EXTERNAL" }, open_in_new_tab: false, no_follow: false },
        }),
      });
    }
    if (textField && newText) {
      await fetch("/api/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleName, fieldPath: textField, value: newText }),
      });
    }
    refreshPreview();
    return;
  }

  const data = await findModuleFields(moduleName);
  if (!data) { refreshPreview(); return; }

  const match = findLinkField(data.fields, anchorEl.href);
  if (match) {
    await fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleName,
        fieldPath: match.path,
        value: {
          url: { href: newUrl, type: "EXTERNAL" },
          open_in_new_tab: match.field.default?.open_in_new_tab ?? false,
          no_follow: match.field.default?.no_follow ?? false,
        },
      }),
    });
  }

  if (newText) {
    const textMatch = findFieldByText(data.fields, anchorEl.textContent, "a");
    if (textMatch) {
      await fetch("/api/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleName, fieldPath: textMatch.path, value: newText }),
      });
    }
  }

  refreshPreview();
}
