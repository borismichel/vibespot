/**
 * Code editor view — file browser + CodeMirror 6 editor.
 * Toggles with the preview in the right panel.
 */

let codeEditorView = null;
let codeFiles = [];
let currentCodeFile = null;
let codeDirty = false;
let codeSavedSinceSwitch = false;

function prettyJson(str) {
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str || ""; }
}

// ---------------------------------------------------------------------------
// File tree building
// ---------------------------------------------------------------------------

function buildCodeFileTree(data) {
  const files = [];

  // Shared files
  if (data.sharedCss) {
    files.push({ id: "shared/theme.css", label: "theme.css", group: "Shared", lang: "css", content: data.sharedCss, shared: "css" });
  }
  if (data.sharedJs) {
    files.push({ id: "shared/animations.js", label: "animations.js", group: "Shared", lang: "javascript", content: data.sharedJs, shared: "js" });
  }

  // Per-module files
  for (const mod of (data.modules || [])) {
    const name = mod.moduleName;
    files.push({ id: name + "/module.html", label: "module.html", group: name, lang: "html", content: mod.moduleHtml, moduleName: name, fileType: "html" });
    files.push({ id: name + "/module.css", label: "module.css", group: name, lang: "css", content: mod.moduleCss, moduleName: name, fileType: "css" });
    if (mod.moduleJs) {
      files.push({ id: name + "/module.js", label: "module.js", group: name, lang: "javascript", content: mod.moduleJs, moduleName: name, fileType: "js" });
    }
    files.push({ id: name + "/fields.json", label: "fields.json", group: name, lang: "json", content: mod.fieldsJson, moduleName: name, fileType: "fields" });
  }

  return files;
}

// ---------------------------------------------------------------------------
// File browser rendering
// ---------------------------------------------------------------------------

const FILE_ICONS = {
  html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  css: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h6"/></svg>',
  javascript: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>',
  json: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/></svg>',
};

function renderCodeFileList(files) {
  const listEl = document.getElementById("code-file-list");
  listEl.innerHTML = "";

  // Group files
  const groups = new Map();
  for (const f of files) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }

  for (const [groupName, groupFiles] of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "code-view__file-group";

    const headerEl = document.createElement("div");
    headerEl.className = "code-view__group-header";
    headerEl.textContent = groupName;
    groupEl.appendChild(headerEl);

    for (const f of groupFiles) {
      const itemEl = document.createElement("div");
      itemEl.className = "code-view__file-item";
      itemEl.dataset.fileId = f.id;
      itemEl.innerHTML = (FILE_ICONS[f.lang] || "") + '<span class="code-view__file-name">' + f.label + "</span>";
      itemEl.addEventListener("click", () => openCodeFile(f));
      groupEl.appendChild(itemEl);
    }

    listEl.appendChild(groupEl);
  }
}

// ---------------------------------------------------------------------------
// Editor management
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom vibespot theme (uses CSS variables for dark/light support)
// ---------------------------------------------------------------------------

function vibespotTheme() {
  const theme = CM.EditorView.theme({
    "&": {
      backgroundColor: "var(--bg-deep, #0a0a0a)",
      color: "var(--text, #f5f0eb)",
    },
    ".cm-content": {
      caretColor: "var(--accent, #e8613a)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent, #e8613a)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-dim, rgba(232,97,58,0.15))",
    },
    ".cm-panels": {
      backgroundColor: "var(--bg-panel-solid, #131110)",
      color: "var(--text, #f5f0eb)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid var(--border, rgba(255,255,255,0.06))",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--accent-dim, rgba(232,97,58,0.15))",
      outline: "1px solid var(--accent-glow, rgba(232,97,58,0.3))",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--accent-dim, rgba(232,97,58,0.15))",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--bg-input, rgba(255,255,255,0.04))",
    },
    ".cm-selectionMatch": {
      backgroundColor: "var(--accent-tint, rgba(232,97,58,0.06))",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "var(--accent-dim, rgba(232,97,58,0.15))",
      outline: "1px solid var(--accent-glow, rgba(232,97,58,0.3))",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-panel-solid, #131110)",
      color: "var(--text-muted, rgba(255,255,255,0.2))",
      border: "none",
      borderRight: "1px solid var(--border, rgba(255,255,255,0.06))",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--bg-input, rgba(255,255,255,0.04))",
      color: "var(--text-dim, rgba(255,255,255,0.45))",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--text-muted)",
    },
    ".cm-tooltip": {
      border: "1px solid var(--border)",
      backgroundColor: "var(--bg-panel-solid)",
      color: "var(--text)",
    },
    ".cm-tooltip .cm-tooltip-arrow:before": {
      borderTopColor: "transparent",
      borderBottomColor: "transparent",
    },
    ".cm-tooltip .cm-tooltip-arrow:after": {
      borderTopColor: "var(--bg-panel-solid)",
      borderBottomColor: "var(--bg-panel-solid)",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-dim)",
        color: "var(--text)",
      },
    },
  }, { dark: true });

  return theme;
}

function vibespotHighlight() {
  const t = CM.tags;
  return CM.syntaxHighlighting(CM.HighlightStyle.define([
    { tag: t.keyword, color: "#c678dd" },
    { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#e06c75" },
    { tag: [t.function(t.variableName), t.labelName], color: "#61afef" },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#d19a66" },
    { tag: [t.definition(t.name), t.separator], color: "#abb2bf" },
    { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#e5c07b" },
    { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#56b6c2" },
    { tag: [t.meta, t.comment], color: "#5c6370", fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.link, color: "#56b6c2", textDecoration: "underline" },
    { tag: t.heading, fontWeight: "bold", color: "#e06c75" },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#d19a66" },
    { tag: [t.processingInstruction, t.string, t.inserted], color: "#98c379" },
    { tag: t.invalid, color: "#ffffff", backgroundColor: "#e06c75" },
  ]));
}

function getLangExtension(lang) {
  if (!window.CM) return [];
  switch (lang) {
    case "html": return [CM.html()];
    case "css": return [CM.css()];
    case "javascript": return [CM.javascript()];
    case "json": return [CM.json()];
    default: return [];
  }
}

function openCodeFile(file) {
  // Warn if dirty
  if (codeDirty && currentCodeFile) {
    if (!confirm("You have unsaved changes. Discard them?")) return;
  }

  currentCodeFile = file;
  codeDirty = false;
  updateDirtyState();

  // Update sidebar selection
  document.querySelectorAll(".code-view__file-item").forEach((el) => {
    el.classList.toggle("code-view__file-item--active", el.dataset.fileId === file.id);
  });

  // Update header
  document.getElementById("code-filename").textContent = file.id;

  // Destroy previous editor
  if (codeEditorView) {
    codeEditorView.destroy();
    codeEditorView = null;
  }

  const area = document.getElementById("code-editor-area");
  area.innerHTML = "";

  if (!window.CM) {
    area.textContent = "CodeMirror not loaded";
    return;
  }

  const saveKeymap = CM.keymap.of([{
    key: "Mod-s",
    run: () => { saveCurrentFile(); return true; },
  }]);

  codeEditorView = new CM.EditorView({
    state: CM.EditorState.create({
      doc: file.lang === "json" ? prettyJson(file.content) : (file.content || ""),
      extensions: [
        CM.basicSetup,
        ...getLangExtension(file.lang),
        vibespotTheme(),
        vibespotHighlight(),
        saveKeymap,
        CM.EditorView.updateListener.of((update) => {
          if (update.docChanged && !codeDirty) {
            codeDirty = true;
            updateDirtyState();
          }
        }),
      ],
    }),
    parent: area,
  });
}

function updateDirtyState() {
  const dot = document.getElementById("code-dirty-dot");
  const btn = document.getElementById("code-save-btn");
  if (codeDirty) {
    dot.classList.remove("hidden");
    btn.disabled = false;
  } else {
    dot.classList.add("hidden");
    btn.disabled = true;
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function saveCurrentFile() {
  if (!currentCodeFile || !codeEditorView || !codeDirty) return;

  const content = codeEditorView.state.doc.toString();
  const btn = document.getElementById("code-save-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const body = currentCodeFile.shared
      ? { shared: currentCodeFile.shared, content }
      : { moduleName: currentCodeFile.moduleName, fileType: currentCodeFile.fileType, content };

    const res = await fetch("/api/modules/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      codeDirty = false;
      codeSavedSinceSwitch = true;
      updateDirtyState();
      // Update the cached content so switching files doesn't lose changes
      currentCodeFile.content = content;
      // Refresh preview so changes are visible when switching back
      if (typeof refreshPreview === "function") refreshPreview();
    } else {
      await vibeAlert(data.error || "Save failed", "Error");
    }
  } catch (err) {
    await vibeAlert("Save failed: " + err.message, "Error");
  } finally {
    btn.textContent = "Save";
    if (!codeDirty) btn.disabled = true;
  }
}

document.getElementById("code-save-btn")?.addEventListener("click", saveCurrentFile);

// ---------------------------------------------------------------------------
// View toggle
// ---------------------------------------------------------------------------

async function loadCodeFiles() {
  try {
    const res = await fetch("/api/modules");
    const data = await res.json();
    codeFiles = buildCodeFileTree(data);
    renderCodeFileList(codeFiles);

    // Auto-select first file if none selected
    if (codeFiles.length > 0 && !currentCodeFile) {
      openCodeFile(codeFiles[0]);
    } else if (currentCodeFile) {
      // Re-sync content from server
      const updated = codeFiles.find((f) => f.id === currentCodeFile.id);
      if (updated && !codeDirty) {
        openCodeFile(updated);
      }
    }
  } catch (err) {
    console.warn("Failed to load code files:", err);
  }
}

document.querySelectorAll(".view-toggle__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    document.querySelectorAll(".view-toggle__btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    const previewEl = document.getElementById("preview-container");
    const codeEl = document.getElementById("code-view");
    const chromeBar = document.getElementById("browser-chrome");

    if (view === "code") {
      previewEl.classList.add("hidden");
      codeEl.classList.remove("hidden");
      loadCodeFiles();
    } else {
      codeEl.classList.add("hidden");
      previewEl.classList.remove("hidden");
      // Refresh preview if code was saved while in code view
      if (codeSavedSinceSwitch && typeof refreshPreview === "function") {
        refreshPreview();
      }
      codeSavedSinceSwitch = false;
    }
  });
});

// Reset code editor state when switching templates/themes
function resetCodeEditor() {
  if (codeEditorView) {
    codeEditorView.destroy();
    codeEditorView = null;
  }
  currentCodeFile = null;
  codeDirty = false;
  codeFiles = [];
  const listEl = document.getElementById("code-file-list");
  if (listEl) listEl.innerHTML = "";
  const area = document.getElementById("code-editor-area");
  if (area) area.innerHTML = "";
  const filename = document.getElementById("code-filename");
  if (filename) filename.textContent = "Select a file";
  updateDirtyState();
}
