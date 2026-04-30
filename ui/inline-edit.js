/**
 * Inline WYSIWYG editing — click elements in the preview to edit them directly.
 * Persists changes via /api/field and refreshes the preview.
 */

const editModeBtn = document.getElementById("edit-mode-toggle");
let editModeActive = false;
let editHandlers = null;

function ensureEditModeStyles(doc) {
  if (doc.getElementById("vibespot-edit-css")) return;
  const style = doc.createElement("style");
  style.id = "vibespot-edit-css";
  style.textContent = `
    html.vibespot-edit-mode { cursor: default; }
    .vibespot-editable-hover {
      outline: 2px dashed rgba(59, 130, 246, 0.6) !important;
      outline-offset: 2px !important;
      cursor: text !important;
    }
    .vibespot-editable-hover[data-edit-type="image"] {
      cursor: pointer !important;
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
      background: #3b82f6;
      padding: 2px 7px;
      border-radius: 3px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      white-space: nowrap;
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

function getEditableInfo(el) {
  if (!el) return null;
  const tag = (el.tagName || "").toLowerCase();

  // Prefer explicit field annotations from the renderer
  const annotated = el.closest("[data-vs-field]");
  if (annotated) {
    const vsType = annotated.getAttribute("data-vs-type");
    if (vsType === "image") return { type: "image", el: annotated };
    if (vsType === "link") return { type: "link", el: annotated };
    return { type: "text", el: annotated };
  }
  const linkAnnotated = el.closest("[data-vs-link]");
  if (linkAnnotated) return { type: "link", el: linkAnnotated };

  // Fallback: heuristic detection for un-annotated elements
  if (tag === "img") return { type: "image", el };
  if (tag === "a" || (el.closest && el.closest("a"))) {
    const anchor = tag === "a" ? el : el.closest("a");
    return { type: "link", el: anchor };
  }
  if (tag.match(/^h[1-6]$/) || tag === "p" || tag === "span" || tag === "li" || tag === "td" || tag === "th") {
    if (el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === "BR")) {
      return { type: "text", el };
    }
    if (el.textContent && el.textContent.trim().length > 0 && el.childElementCount <= 2) {
      return { type: "text", el };
    }
  }
  if (tag === "button") return { type: "text", el };

  return null;
}

function attachEditHandlers() {
  let doc;
  try {
    doc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
  } catch { return; }
  if (!doc || !doc.body) return;

  ensureEditModeStyles(doc);
  doc.documentElement.classList.add("vibespot-edit-mode");

  let hoveredEl = null;
  let labelEl = null;
  let activeEditor = null;

  const cleanup = () => {
    if (hoveredEl) {
      hoveredEl.classList.remove("vibespot-editable-hover");
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
    const info = getEditableInfo(e.target);
    if (!info) {
      cleanup();
      return;
    }
    if (hoveredEl === info.el) return;
    cleanup();
    hoveredEl = info.el;
    hoveredEl.classList.add("vibespot-editable-hover");
    hoveredEl.setAttribute("data-edit-type", info.type);

    if (!labelEl) {
      labelEl = doc.createElement("div");
      labelEl.className = "vibespot-edit-label";
      doc.body.appendChild(labelEl);
    }
    const typeLabel = info.type === "image" ? "Click to edit image" : info.type === "link" ? "Click to edit link" : "Click to edit";
    labelEl.textContent = typeLabel;
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

    const info = getEditableInfo(e.target);
    if (!info) return;

    closeActiveEditor();
    cleanup();

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
    if (e.key === "Escape" && !activeEditor) deactivateEditMode();
  };

  doc.addEventListener("mouseover", onMouseOver, true);
  doc.addEventListener("mouseout", onMouseOut, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeyDown, true);

  editHandlers = {
    doc,
    onMouseOver,
    onMouseOut,
    onClick,
    onKeyDown,
    cleanup,
    closeActiveEditor,
  };
}

function detachEditHandlers() {
  if (!editHandlers) return;
  const { doc, onMouseOver, onMouseOut, onClick, onKeyDown, cleanup, closeActiveEditor } = editHandlers;
  try {
    closeActiveEditor();
    cleanup();
    doc.documentElement.classList.remove("vibespot-edit-mode");
    doc.removeEventListener("mouseover", onMouseOver, true);
    doc.removeEventListener("mouseout", onMouseOut, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  } catch { /* cross-origin */ }
  editHandlers = null;
}

function activateEditMode() {
  if (editModeActive) return;
  if (typeof deactivateSelectMode === "function") deactivateSelectMode();
  editModeActive = true;
  if (editModeBtn) editModeBtn.setAttribute("aria-pressed", "true");
  attachEditHandlers();
}

function deactivateEditMode() {
  if (!editModeActive) return;
  editModeActive = false;
  if (editModeBtn) editModeBtn.setAttribute("aria-pressed", "false");
  detachEditHandlers();
}

function setEditModeDisabled(disabled) {
  if (!editModeBtn) return;
  if (disabled) {
    deactivateEditMode();
    editModeBtn.disabled = true;
  } else {
    editModeBtn.disabled = false;
  }
}

if (editModeBtn) {
  editModeBtn.addEventListener("click", () => {
    if (editModeBtn.disabled) return;
    if (editModeActive) deactivateEditMode();
    else activateEditMode();
  });
}

if (previewFrame) {
  previewFrame.addEventListener("load", () => {
    if (editModeActive) attachEditHandlers();
  });
}

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

  // Fallback: text-content matching for un-annotated elements
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

  // Fallback: heuristic matching
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

  // Fallback: heuristic matching
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

window.setEditModeDisabled = setEditModeDisabled;
window.deactivateEditMode = deactivateEditMode;
