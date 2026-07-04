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

// The agent may *request* dropping back to view mode (Esc in-frame with no
// editor open). Only the exit request is honoured — a compromised frame can
// lower its privileges, never raise them — and the toolbar flip re-issues
// vs:set-mode, so the parent stays authoritative over the mode.
onPreviewMessage("vs:request-mode", (p) => {
  if (!p || p.mode !== "view") return;
  deactivateInteractMode();
});

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

function collectFieldsOfType(fields, type, prefix = "", out = []) {
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (field.type === "group" && field.children) {
      collectFieldsOfType(field.children, type, path, out);
      continue;
    }
    if (field.type === type) out.push({ path, field });
  }
  return out;
}

// The agent reports the DOM's absolutized URL (possibly with a preview access
// token in the query) while field defaults are often relative — compare
// without query/hash and accept a suffix match either way.
function urlLikeMatches(a, b) {
  a = String(a || "").split(/[?#]/)[0];
  b = String(b || "").split(/[?#]/)[0];
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/** Match the edited image by its pre-edit src so editing the 2nd image can't
 * overwrite the 1st (VIB-1898). Falls back to a lone image field only. */
function findImageField(fields, imgSrc) {
  const candidates = collectFieldsOfType(fields, "image");
  const bySrc = candidates.find((c) => urlLikeMatches(c.field.default?.src || "", imgSrc || ""));
  if (bySrc) return bySrc;
  return candidates.length === 1 ? candidates[0] : null;
}

/** Same per-href matching for link fields (VIB-1898). */
function findLinkField(fields, href) {
  const candidates = collectFieldsOfType(fields, "link");
  const byHref = candidates.find((c) => urlLikeMatches(c.field.default?.url?.href || "", href || ""));
  if (byHref) return byHref;
  return candidates.length === 1 ? candidates[0] : null;
}

function postField(moduleName, fieldPath, value) {
  // Unified save path (field-save.js); the commit handlers refresh the
  // preview once per commit rather than once per POST.
  return saveField(moduleName, fieldPath, value, { refresh: false });
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

  // Only write the URL when the user actually changed it — a text-only edit
  // must not blank the stored href (VIB-1898).
  const match = newUrl && newUrl !== (p.origHref || "") ? findLinkField(data.fields, p.origHref || "") : null;
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
