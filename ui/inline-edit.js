/**
 * Unified interact mode — parent end (VIB-1892).
 *
 * The hover/edit UI itself lives in the cross-origin preview frame and is run
 * by the trusted agent (ui/preview-agent.js). This file owns the toolbar
 * toggle, tells the agent which mode is active (vs:set-mode via preview.js),
 * and maps the agent's committed edits (vs:edit-commit / vs:select-module)
 * onto module fields via /api/field. The frame can only ever request the
 * field-edit writes handled here — nothing else crosses the boundary.
 */

const interactBtn = document.getElementById("interact-mode-toggle");
let interactModeActive = false;

function activateInteractMode() {
  if (interactModeActive) return;
  interactModeActive = true;
  if (interactBtn) interactBtn.setAttribute("aria-pressed", "true");
  const previewContainer = document.getElementById("preview-container");
  if (previewContainer) previewContainer.classList.add("preview--interact-mode");
  setPreviewMode("interact");
}

function deactivateInteractMode() {
  if (!interactModeActive) return;
  interactModeActive = false;
  if (interactBtn) interactBtn.setAttribute("aria-pressed", "false");
  const previewContainer = document.getElementById("preview-container");
  if (previewContainer) previewContainer.classList.remove("preview--interact-mode");
  setPreviewMode("view");
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

// Backward-compat aliases
window.setEditModeDisabled = setInteractModeDisabled;
window.deactivateEditMode = deactivateInteractMode;
window.setSelectModeDisabled = setInteractModeDisabled;
window.deactivateSelectMode = deactivateInteractMode;

// ---------------------------------------------------------------------------
// Agent messages: module select -> chat prefill; edit commits -> field saves
// ---------------------------------------------------------------------------

onPreviewMessage("vs:select-module", (p) => {
  if (typeof p.prefill !== "string") return;
  if (typeof window.prefillChatInput === "function") {
    // Preview content is AI-authored — cap the prefill so a hostile page
    // can't stuff the composer.
    window.prefillChatInput(p.prefill.slice(0, 400));
  }
});

onPreviewMessage("vs:edit-commit", (p) => {
  if (!p || typeof p.moduleName !== "string" || !p.moduleName) return;
  if (p.kind === "text" && typeof p.value === "string") {
    saveTextChange(p.moduleName, p);
  } else if (p.kind === "image" && typeof p.value === "string") {
    saveImageChange(p.moduleName, p);
  } else if (p.kind === "link") {
    saveLinkChange(p.moduleName, p);
  }
});

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

async function postField(moduleName, fieldPath, value) {
  await fetch("/api/field", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moduleName, fieldPath, value }),
  });
}

/** p: { fieldPath?, originalText, tag, value } from vs:edit-commit. */
async function saveTextChange(moduleName, p) {
  if (typeof p.fieldPath === "string" && p.fieldPath) {
    await postField(moduleName, p.fieldPath, p.value);
    refreshPreview();
    return;
  }

  const data = await findModuleFields(moduleName);
  if (!data) { refreshPreview(); return; }

  const originalText = typeof p.originalText === "string" && p.originalText ? p.originalText : p.value;
  const match = findFieldByText(data.fields, originalText, p.tag || "");
  if (match) {
    await postField(moduleName, match.path, p.value);
  }
  refreshPreview();
}

/** p: { fieldPath?, alt?, oldSrc?, value } from vs:edit-commit. */
async function saveImageChange(moduleName, p) {
  if (typeof p.fieldPath === "string" && p.fieldPath) {
    await postField(moduleName, p.fieldPath, {
      src: p.value,
      alt: typeof p.alt === "string" ? p.alt : "",
    });
    refreshPreview();
    return;
  }

  const data = await findModuleFields(moduleName);
  if (!data) { refreshPreview(); return; }

  const match = findImageField(data.fields, p.oldSrc || "");
  if (match) {
    await postField(moduleName, match.path, {
      src: p.value,
      alt: match.field.default?.alt || "",
    });
  }
  refreshPreview();
}

/** p: { linkField?, textField?, origText?, origHref?, newText?, newUrl? }. */
async function saveLinkChange(moduleName, p) {
  const newText = typeof p.newText === "string" ? p.newText : "";
  const newUrl = typeof p.newUrl === "string" ? p.newUrl : "";
  const linkField = typeof p.linkField === "string" ? p.linkField : "";
  const textField = typeof p.textField === "string" ? p.textField : "";

  if (linkField || textField) {
    if (linkField && newUrl) {
      await postField(moduleName, linkField, {
        url: { href: newUrl, type: "EXTERNAL" },
        open_in_new_tab: false,
        no_follow: false,
      });
    }
    if (textField && newText) {
      await postField(moduleName, textField, newText);
    }
    refreshPreview();
    return;
  }

  const data = await findModuleFields(moduleName);
  if (!data) { refreshPreview(); return; }

  const match = findLinkField(data.fields, p.origHref || "");
  if (match) {
    await postField(moduleName, match.path, {
      url: { href: newUrl, type: "EXTERNAL" },
      open_in_new_tab: match.field.default?.open_in_new_tab ?? false,
      no_follow: match.field.default?.no_follow ?? false,
    });
  }

  if (newText) {
    // Match the pre-edit text so the right field default is found.
    const textMatch = findFieldByText(data.fields, p.origText || newText, "a");
    if (textMatch) {
      await postField(moduleName, textMatch.path, newText);
    }
  }

  refreshPreview();
}
