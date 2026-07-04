/**
 * Unified /api/field save path (VIB-1898).
 *
 * All three field-editing surfaces persist through this module — the field
 * editor sidebar (field-editor.js), inline interact-mode edits
 * (inline-edit.js) and the section-controls commits (section-controls.js).
 * The debounce is keyed PER FIELD, so editing a second field never cancels
 * the first field's pending save, and saves to the same field are chained so
 * an earlier POST can't land after a later one.
 */

/** key -> { timer, moduleName, fieldPath, value, opts } */
const fieldSavePending = new Map();
/** key -> tail of that field's in-flight POST chain */
const fieldSaveChains = new Map();
const FIELD_SAVE_DEBOUNCE_MS = 300;

function fieldSaveKey(moduleName, fieldPath) {
  return `${moduleName}\u0000${fieldPath}`;
}

/**
 * Save one field value now.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.refresh=true] Refresh the preview after the POST.
 * @returns {Promise<void>} resolves after the POST (and refresh) settle.
 */
function saveField(moduleName, fieldPath, value, opts = {}) {
  const key = fieldSaveKey(moduleName, fieldPath);
  // An immediate save supersedes any older debounced value for the field.
  const pending = fieldSavePending.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    fieldSavePending.delete(key);
  }
  const tail = fieldSaveChains.get(key) || Promise.resolve();
  const post = tail
    .then(() =>
      fetch("/api/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleName, fieldPath, value }),
      })
    )
    .then(() => {
      if (opts.refresh !== false) refreshPreview();
    })
    .catch(() => {
      /* field save failed — preview keeps its optimistic state */
    });
  fieldSaveChains.set(key, post);
  post.then(() => {
    if (fieldSaveChains.get(key) === post) fieldSaveChains.delete(key);
  });
  return post;
}

/**
 * Debounced save, keyed per field — pending edits to OTHER fields are
 * untouched. Same opts as saveField, plus opts.debounceMs.
 */
function saveFieldDebounced(moduleName, fieldPath, value, opts = {}) {
  const key = fieldSaveKey(moduleName, fieldPath);
  const prev = fieldSavePending.get(key);
  if (prev) clearTimeout(prev.timer);
  const entry = { moduleName, fieldPath, value, opts };
  entry.timer = setTimeout(() => {
    fieldSavePending.delete(key);
    saveField(moduleName, fieldPath, value, opts);
  }, opts.debounceMs ?? FIELD_SAVE_DEBOUNCE_MS);
  fieldSavePending.set(key, entry);
}

/** Fire every pending debounced save immediately (e.g. the editor closes). */
function flushPendingFieldSaves() {
  for (const [key, entry] of Array.from(fieldSavePending)) {
    clearTimeout(entry.timer);
    fieldSavePending.delete(key);
    saveField(entry.moduleName, entry.fieldPath, entry.value, entry.opts);
  }
}
