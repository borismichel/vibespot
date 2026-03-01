/**
 * Field editor sidebar — edit module field values with live preview.
 */

const editorEl = document.getElementById("field-editor");
const editorTitle = document.getElementById("field-editor-title");
const editorContent = document.getElementById("field-editor-content");
const editorClose = document.getElementById("field-editor-close");

let currentEditModule = null;

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

async function openFieldEditor(moduleName) {
  currentEditModule = moduleName;
  editorTitle.textContent = moduleName;
  editorEl.classList.add("open");

  // Fetch module data
  try {
    const res = await fetch("/api/modules");
    const data = await res.json();
    const mod = data.modules.find((m) => m.moduleName === moduleName);
    if (!mod) {
      editorContent.innerHTML = "<p>Module not found</p>";
      return;
    }

    const fields = JSON.parse(mod.fieldsJson);
    renderFieldForm(fields, moduleName);
  } catch (err) {
    editorContent.innerHTML = `<p>Error: ${err.message}</p>`;
  }
}

function closeFieldEditor() {
  editorEl.classList.remove("open");
  currentEditModule = null;
}

editorClose.addEventListener("click", closeFieldEditor);

// ---------------------------------------------------------------------------
// Render field form
// ---------------------------------------------------------------------------

function renderFieldForm(fields, moduleName, prefix = "") {
  editorContent.innerHTML = "";

  for (const field of fields) {
    const fullPath = prefix ? `${prefix}.${field.name}` : field.name;

    // Skip meta fields
    if (field.name === "id") continue;

    if (field.type === "group" && field.children) {
      // Render group header
      const group = document.createElement("div");
      group.className = "field-group";

      if (field.tab === "STYLE") {
        const tabLabel = document.createElement("div");
        tabLabel.className = "field-group__tab-label";
        tabLabel.textContent = "Style";
        group.appendChild(tabLabel);
      }

      const label = document.createElement("label");
      label.className = "field-group__label";
      label.textContent = field.label || field.name;
      group.appendChild(label);

      // Render children
      for (const child of field.children) {
        const childEl = createFieldInput(child, moduleName, `${fullPath}.${child.name}`);
        if (childEl) group.appendChild(childEl);
      }

      editorContent.appendChild(group);
    } else {
      const el = createFieldInput(field, moduleName, fullPath);
      if (el) editorContent.appendChild(el);
    }
  }
}

// ---------------------------------------------------------------------------
// Create field inputs by type
// ---------------------------------------------------------------------------

function createFieldInput(field, moduleName, fullPath) {
  const group = document.createElement("div");
  group.className = "field-group";

  const label = document.createElement("label");
  label.className = "field-group__label";
  label.textContent = field.label || field.name;
  group.appendChild(label);

  switch (field.type) {
    case "text": {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "field-input";
      input.value = field.default || "";
      input.addEventListener("change", () => {
        updateField(moduleName, fullPath, input.value);
      });
      group.appendChild(input);
      break;
    }

    case "richtext": {
      const textarea = document.createElement("textarea");
      textarea.className = "field-input";
      textarea.rows = 3;
      textarea.value = field.default || "";
      textarea.addEventListener("change", () => {
        updateField(moduleName, fullPath, textarea.value);
      });
      group.appendChild(textarea);
      break;
    }

    case "color": {
      const wrapper = document.createElement("div");
      wrapper.className = "field-color";

      const picker = document.createElement("input");
      picker.type = "color";
      picker.className = "field-color__picker";
      picker.value = field.default?.color || "#000000";

      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "field-input field-color__hex";
      hex.value = field.default?.color || "#000000";

      picker.addEventListener("input", () => {
        hex.value = picker.value;
        updateField(moduleName, fullPath, {
          color: picker.value,
          opacity: field.default?.opacity ?? 100,
        });
      });

      hex.addEventListener("change", () => {
        picker.value = hex.value;
        updateField(moduleName, fullPath, {
          color: hex.value,
          opacity: field.default?.opacity ?? 100,
        });
      });

      wrapper.appendChild(picker);
      wrapper.appendChild(hex);
      group.appendChild(wrapper);
      break;
    }

    case "image": {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "field-input";
      input.placeholder = "Image URL";
      input.value = field.default?.src || "";
      input.addEventListener("change", () => {
        updateField(moduleName, fullPath, {
          src: input.value,
          alt: field.default?.alt || "",
        });
      });
      group.appendChild(input);
      break;
    }

    case "link": {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "field-input";
      input.placeholder = "URL";
      input.value = field.default?.url?.href || "";
      input.addEventListener("change", () => {
        updateField(moduleName, fullPath, {
          url: { href: input.value, type: "EXTERNAL" },
          open_in_new_tab: field.default?.open_in_new_tab ?? false,
          no_follow: field.default?.no_follow ?? false,
        });
      });
      group.appendChild(input);
      break;
    }

    case "number": {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "field-input";
      input.value = field.default ?? 0;
      input.addEventListener("change", () => {
        updateField(moduleName, fullPath, Number(input.value));
      });
      group.appendChild(input);
      break;
    }

    case "boolean": {
      const wrapper = document.createElement("label");
      wrapper.style.display = "flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "8px";
      wrapper.style.cursor = "pointer";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = field.default ?? false;
      checkbox.addEventListener("change", () => {
        updateField(moduleName, fullPath, checkbox.checked);
      });

      const span = document.createElement("span");
      span.textContent = field.label || field.name;
      span.style.fontSize = "13px";

      wrapper.appendChild(checkbox);
      wrapper.appendChild(span);
      group.innerHTML = "";
      group.appendChild(wrapper);
      break;
    }

    case "choice": {
      const select = document.createElement("select");
      select.className = "field-input";

      const choices = field.choices || [];
      for (const choice of choices) {
        const option = document.createElement("option");
        if (Array.isArray(choice)) {
          option.value = choice[0];
          option.textContent = choice[1];
        } else {
          option.value = choice;
          option.textContent = choice;
        }
        select.appendChild(option);
      }
      select.value = field.default || "";
      select.addEventListener("change", () => {
        updateField(moduleName, fullPath, select.value);
      });
      group.appendChild(select);
      break;
    }

    default:
      // Unknown field type — show as text input
      if (typeof field.default === "string" || typeof field.default === "number") {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "field-input";
        input.value = field.default ?? "";
        input.addEventListener("change", () => {
          updateField(moduleName, fullPath, input.value);
        });
        group.appendChild(input);
      } else {
        return null;
      }
  }

  return group;
}

// ---------------------------------------------------------------------------
// Update field and refresh preview
// ---------------------------------------------------------------------------

let updateTimer = null;

function updateField(moduleName, fieldPath, value) {
  // Debounce updates
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleName, fieldPath, value }),
    }).then(() => refreshPreview());
  }, 300);
}
