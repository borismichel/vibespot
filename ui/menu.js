/**
 * Hamburger menu — theme switching, actions
 */

let menuOpen = false;

function openMenu() {
  const dropdown = document.getElementById("menu-dropdown");
  dropdown.classList.remove("hidden");
  menuOpen = true;
  fetchAndRenderMenu();
  // Close on click outside
  setTimeout(() => document.addEventListener("click", onMenuClickOutside), 0);
  document.addEventListener("keydown", onMenuEscape);
}

function closeMenu() {
  const dropdown = document.getElementById("menu-dropdown");
  dropdown.classList.add("hidden");
  menuOpen = false;
  document.removeEventListener("click", onMenuClickOutside);
  document.removeEventListener("keydown", onMenuEscape);
}

function toggleMenu() {
  menuOpen ? closeMenu() : openMenu();
}

function onMenuClickOutside(e) {
  const dropdown = document.getElementById("menu-dropdown");
  if (!dropdown.contains(e.target) && !e.target.closest(".topbar__hamburger")) {
    closeMenu();
  }
}

function onMenuEscape(e) {
  if (e.key === "Escape") closeMenu();
}

async function fetchAndRenderMenu() {
  const list = document.getElementById("menu-theme-list");
  list.innerHTML = '<div class="menu__loading">Loading...</div>';

  try {
    const res = await fetch("/api/themes");
    const data = await res.json();
    renderMenuThemes(data);
  } catch {
    list.innerHTML = '<div class="menu__loading">Failed to load themes</div>';
  }
}

function renderMenuThemes(data) {
  const list = document.getElementById("menu-theme-list");
  list.innerHTML = "";

  const sessions = data.sessions || [];
  const activeId = data.activeTheme?.id;

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu__empty";
    empty.textContent = "No themes yet";
    list.appendChild(empty);
    return;
  }

  sessions.forEach((s) => {
    const item = document.createElement("button");
    item.className = "menu__theme-item" + (s.id === activeId ? " active" : "");

    const dot = document.createElement("span");
    dot.className = "menu__dot" + (s.id === activeId ? " menu__dot--active" : "");
    item.appendChild(dot);

    const name = document.createElement("span");
    name.className = "menu__theme-name";
    name.textContent = s.themeName;
    item.appendChild(name);

    if (s.updatedAt) {
      const time = document.createElement("span");
      time.className = "menu__theme-time";
      time.textContent = timeAgo(s.updatedAt);
      item.appendChild(time);
    }

    // Delete button (hidden until hover)
    const del = document.createElement("span");
    del.className = "menu__theme-delete";
    del.innerHTML = "&times;";
    del.title = "Delete theme";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTheme(s.id, s.themeName);
    });
    item.appendChild(del);

    // Click to switch
    if (s.id !== activeId) {
      item.addEventListener("click", () => switchTheme(s.id));
    }

    list.appendChild(item);
  });
}

async function switchTheme(sessionId) {
  closeMenu();
  const statusText = document.getElementById("status-text");
  if (statusText) statusText.textContent = "Switching theme...";

  try {
    const res = await fetch("/api/themes/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (data.ok) {
      // Reload the page to reinitialize WebSocket and UI
      window.location.reload();
    }
  } catch {
    if (statusText) statusText.textContent = "Failed to switch theme";
  }
}

async function createThemeFromMenu() {
  const input = document.getElementById("menu-new-theme");
  const name = input.value.trim();
  if (!name) return;

  closeMenu();
  const statusText = document.getElementById("status-text");
  if (statusText) statusText.textContent = "Creating theme...";

  try {
    const res = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.themeName) {
      window.location.reload();
    } else if (data.error) {
      if (statusText) statusText.textContent = data.error;
    }
  } catch {
    if (statusText) statusText.textContent = "Failed to create theme";
  }
}

async function deleteTheme(sessionId, themeName) {
  if (!confirm(`Delete "${themeName}"? This removes the session. Theme files on disk will be kept.`)) return;

  try {
    const res = await fetch("/api/themes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, deleteFiles: false }),
    });
    await res.json();
    fetchAndRenderMenu();
  } catch {
    // Ignore
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

// Wire up hamburger buttons (called from DOMContentLoaded)
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".topbar__hamburger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
  });

  const createBtn = document.getElementById("menu-create-btn");
  if (createBtn) {
    createBtn.addEventListener("click", createThemeFromMenu);
  }

  const createInput = document.getElementById("menu-new-theme");
  if (createInput) {
    createInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") createThemeFromMenu();
    });
  }

  // Menu action buttons
  const menuSettings = document.getElementById("menu-settings");
  if (menuSettings) {
    menuSettings.addEventListener("click", () => {
      closeMenu();
      if (typeof openSettings === "function") openSettings();
    });
  }

  const menuUpload = document.getElementById("menu-upload");
  if (menuUpload) {
    menuUpload.addEventListener("click", () => {
      closeMenu();
      if (typeof startUpload === "function") startUpload();
    });
  }
});
