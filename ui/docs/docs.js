/* vibeSpot Documentation — Search, Navigation, Interactive Elements */

(function () {
  "use strict";

  // ================================================================
  // Sidebar scroll spy — highlight active section on scroll
  // ================================================================
  const navLinks = document.querySelectorAll(".doc-nav__link[href^='#']");
  const sections = [];

  navLinks.forEach((link) => {
    const id = link.getAttribute("href").slice(1);
    const el = document.getElementById(id);
    if (el) sections.push({ id, el, link });
  });

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const scrollY = window.scrollY + 100;
      let current = sections[0];
      for (const s of sections) {
        if (s.el.offsetTop <= scrollY) current = s;
      }
      navLinks.forEach((l) => l.classList.remove("active"));
      if (current) current.link.classList.add("active");
      ticking = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ================================================================
  // Collapsible sections
  // ================================================================
  document.querySelectorAll(".doc-collapse__trigger").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".doc-collapse").classList.toggle("open");
    });
  });

  // ================================================================
  // Tabs
  // ================================================================
  document.querySelectorAll(".doc-tabs").forEach((tabGroup) => {
    const tabs = tabGroup.querySelectorAll(".doc-tabs__tab");
    const panels = tabGroup.querySelectorAll(".doc-tabs__panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        const target = tabGroup.querySelector(`#${tab.dataset.tab}`);
        if (target) target.classList.add("active");
      });
    });
  });

  // ================================================================
  // Code copy buttons
  // ================================================================
  document.querySelectorAll("pre").forEach((pre) => {
    const btn = document.createElement("button");
    btn.className = "doc-code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent || pre.textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      });
    });
    pre.appendChild(btn);
  });

  // ================================================================
  // Search
  // ================================================================
  const searchInput = document.getElementById("doc-search-input");
  const searchResults = document.getElementById("doc-search-results");
  if (!searchInput || !searchResults) return;

  // Build search index from all headings and paragraphs
  const searchIndex = [];
  document.querySelectorAll(".doc-section").forEach((section) => {
    const sectionTitle = section.querySelector("h2")?.textContent || "";
    section.querySelectorAll("h2, h3, h4, p, li, td, .doc-callout").forEach((el) => {
      const text = el.textContent.trim();
      if (!text || text.length < 10) return;
      const heading = el.closest("h2, h3, h4") ? el : el.previousElementSibling;
      const title = el.tagName.match(/^H[234]$/) ? text : (
        findNearestHeading(el)?.textContent || sectionTitle
      );
      const id = findNearestId(el) || section.id;
      searchIndex.push({ title, text: text.slice(0, 300), section: sectionTitle, id });
    });
  });

  function findNearestHeading(el) {
    let node = el.previousElementSibling;
    while (node) {
      if (node.tagName && node.tagName.match(/^H[234]$/)) return node;
      node = node.previousElementSibling;
    }
    return el.closest(".doc-section")?.querySelector("h2");
  }

  function findNearestId(el) {
    let node = el;
    while (node) {
      if (node.id) return node.id;
      const prev = node.previousElementSibling;
      if (prev?.id) return prev.id;
      node = node.parentElement;
    }
    return "";
  }

  let focusedIdx = -1;

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) {
      searchResults.classList.remove("visible");
      searchResults.innerHTML = "";
      focusedIdx = -1;
      return;
    }

    const words = q.split(/\s+/);
    const matches = [];
    const seen = new Set();

    for (const entry of searchIndex) {
      const lower = (entry.title + " " + entry.text).toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        const key = entry.id + "|" + entry.title.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(entry);
        if (matches.length >= 12) break;
      }
    }

    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="doc-search-empty">No results found</div>';
      searchResults.classList.add("visible");
      focusedIdx = -1;
      return;
    }

    searchResults.innerHTML = matches.map((m, i) => {
      const snippet = highlightSnippet(m.text, words);
      return `<a class="doc-search-result" href="#${m.id}" data-idx="${i}">
        <div class="doc-search-result__title">${escapeHtml(m.title)}<span class="doc-search-result__section">${escapeHtml(m.section)}</span></div>
        <div class="doc-search-result__snippet">${snippet}</div>
      </a>`;
    }).join("");
    searchResults.classList.add("visible");
    focusedIdx = -1;

    // Click result → navigate and close
    searchResults.querySelectorAll(".doc-search-result").forEach((r) => {
      r.addEventListener("click", () => {
        searchResults.classList.remove("visible");
        searchInput.value = "";
        closeSidebar();
      });
    });
  });

  searchInput.addEventListener("keydown", (e) => {
    const items = searchResults.querySelectorAll(".doc-search-result");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIdx = Math.min(focusedIdx + 1, items.length - 1);
      updateFocus(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIdx = Math.max(focusedIdx - 1, 0);
      updateFocus(items);
    } else if (e.key === "Enter" && focusedIdx >= 0) {
      e.preventDefault();
      items[focusedIdx].click();
    } else if (e.key === "Escape") {
      searchResults.classList.remove("visible");
      searchInput.blur();
    }
  });

  function updateFocus(items) {
    items.forEach((el, i) => el.classList.toggle("focused", i === focusedIdx));
    if (focusedIdx >= 0) items[focusedIdx].scrollIntoView({ block: "nearest" });
  }

  // Close search on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".doc-topbar__search") && !e.target.closest(".doc-search-results")) {
      searchResults.classList.remove("visible");
    }
  });

  // Keyboard shortcut: / to focus search
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.target.closest("input, textarea, [contenteditable]")) {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === "Escape") {
      searchResults.classList.remove("visible");
      searchInput.blur();
    }
  });

  function highlightSnippet(text, words) {
    let s = escapeHtml(text.slice(0, 160));
    for (const w of words) {
      const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      s = s.replace(re, "<mark>$1</mark>");
    }
    return s + (text.length > 160 ? "..." : "");
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ================================================================
  // Mobile sidebar toggle
  // ================================================================
  const menuBtn = document.getElementById("doc-menu-btn");
  const sidebar = document.querySelector(".doc-sidebar");

  if (menuBtn && sidebar) {
    menuBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });
    // Close sidebar on nav link click (mobile)
    sidebar.querySelectorAll(".doc-nav__link").forEach((l) => {
      l.addEventListener("click", () => closeSidebar());
    });
  }

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove("open");
  }

  // ================================================================
  // Smooth scroll for sidebar links (close sidebar on mobile)
  // ================================================================
  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      const id = link.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth" });
        history.replaceState(null, "", "#" + id);
      }
      closeSidebar();
    });
  });
})();
