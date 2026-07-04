/**
 * Upload panel — slide-up log for live hs upload output
 */

let uploadState = "idle";
let uploadAttempt = 0;
let lastUploadErrors = [];
let lastUploadPortalId = "";
let lastUploadDataCenter = "na1";
let lastUploadThemeName = "";
let lastUploadContentMode = "page";
const MAX_UPLOAD_ATTEMPTS = 3;

async function startUpload() {
  if (uploadState === "uploading" || uploadState === "ai_fixing") return;

  const uploadBtn = document.getElementById("btn-upload");
  if (uploadBtn) {
    uploadBtn.innerHTML = '<span class="upload-spinner"></span>';
    uploadBtn.disabled = true;
  }

  function resetUploadBtn() {
    if (uploadBtn) { uploadBtn.textContent = "Deploy"; uploadBtn.disabled = false; }
  }

  // Fetch portal info and check readiness
  try {
    const res = await fetch("/api/settings/status");
    const data = await res.json();
    const uploadMode = data.config?.hubspotUploadMode || "api";
    let hs = data.environment?.tools?.hubspot;

    if (uploadMode === "api") {
      // API mode — just need a PAK configured
      const accounts = data.config?.hubspotAccounts || [];
      if (accounts.length === 0) {
        const authed = await showHubSpotSetupDialog("auth");
        if (!authed) { resetUploadBtn(); return; }
        const recheck = await fetch("/api/settings/status").then((r) => r.json());
        hs = recheck.environment?.tools?.hubspot;
      }
      // Confirm portal
      if (hs && hs.authenticated && hs.portalName) {
        const confirmed = await confirmUpload(hs.portalName, hs.portalId);
        if (!confirmed) { resetUploadBtn(); return; }
      }
    } else {
      // CLI mode — need CLI installed and authed
      if (!hs || !hs.found) {
        const installed = await showHubSpotSetupDialog("install");
        if (!installed) { resetUploadBtn(); return; }
        const recheck = await fetch("/api/settings/status").then((r) => r.json());
        hs = recheck.environment?.tools?.hubspot;
      }
      if (hs && hs.found && !hs.authenticated) {
        const authed = await showHubSpotSetupDialog("auth");
        if (!authed) { resetUploadBtn(); return; }
        const recheck = await fetch("/api/settings/status").then((r) => r.json());
        hs = recheck.environment?.tools?.hubspot;
      }
      if (hs && hs.authenticated && hs.portalName) {
        const confirmed = await confirmUpload(hs.portalName, hs.portalId);
        if (!confirmed) { resetUploadBtn(); return; }
      }
    }
  } catch {
    // If we can't detect, proceed and let the upload fail with a meaningful error
  }

  doUpload();
}

/**
 * Show a dialog to guide the user through HubSpot CLI install or auth.
 * @param {"install" | "auth"} mode
 * @returns {Promise<boolean>} true if the step completed successfully
 */
function showHubSpotSetupDialog(mode) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    if (mode === "install") {
      overlay.innerHTML = `
        <div class="confirm-dialog" style="width:420px">
          <div class="confirm-dialog__title">Install HubSpot CLI</div>
          <p class="confirm-dialog__detail">The HubSpot CLI is needed to deploy your theme. This will run <code>npm install -g @hubspot/cli</code>.</p>
          <div class="confirm-dialog__actions">
            <button class="btn btn--secondary" data-action="cancel">Cancel</button>
            <button class="btn btn--primary" data-action="install">Install</button>
          </div>
          <div class="hs-setup__status hidden" id="hs-install-status">
            <span class="upload-spinner"></span> Installing...
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

      overlay.querySelector('[data-action="install"]').addEventListener("click", async () => {
        const installBtn = overlay.querySelector('[data-action="install"]');
        installBtn.disabled = true;
        installBtn.textContent = "Installing...";
        const statusEl = document.getElementById("hs-install-status");
        if (statusEl) statusEl.classList.remove("hidden");

        try {
          const res = await fetch("/api/settings/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "hubspot" }),
          });
          const data = await res.json();
          if (data.jobId) {
            // pollJob (setup.js) resolves on success and throws on
            // failure / lost job (404) / timeout.
            await pollJob(data.jobId);
            close(true);
            return;
          }
          close(false);
        } catch (err) {
          await vibeAlert("Install failed: " + (err.message || err), "Error");
          close(false);
        }
      });

    } else {
      // Auth mode — PAK flow
      overlay.innerHTML = `
        <div class="confirm-dialog" style="width:460px">
          <div class="confirm-dialog__title">Connect your HubSpot account</div>
          <p class="confirm-dialog__detail">Create a Personal Access Key to connect vibeSpot to your HubSpot portal.</p>
          <ol class="hs-setup__steps">
            <li>Open <a href="https://app.hubspot.com/l/personal-access-key" target="_blank" rel="noopener">HubSpot Personal Access Key</a></li>
            <li>Create a key with the <strong>Content</strong> scope enabled</li>
            <li>Paste the key below</li>
          </ol>
          <input type="password" class="confirm-dialog__input" id="hs-pak-input" placeholder="pat-na1-..." />
          <div class="confirm-dialog__actions">
            <button class="btn btn--secondary" data-action="cancel">Cancel</button>
            <button class="btn btn--primary" data-action="save">Connect</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

      const pakInput = document.getElementById("hs-pak-input");
      const saveBtn = overlay.querySelector('[data-action="save"]');

      const doSave = async () => {
        const key = pakInput.value.trim();
        if (!key) return;
        saveBtn.disabled = true;
        saveBtn.textContent = "Connecting...";
        try {
          const res = await fetch("/api/settings/hs-auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personalAccessKey: key }),
          });
          const data = await res.json();
          if (data.error) {
            await vibeAlert(data.error, "Error");
            saveBtn.disabled = false;
            saveBtn.textContent = "Connect";
            return;
          }
          close(true);
        } catch (err) {
          await vibeAlert("Failed to connect: " + err.message, "Error");
          saveBtn.disabled = false;
          saveBtn.textContent = "Connect";
        }
      };

      saveBtn.addEventListener("click", doSave);
      pakInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
      setTimeout(() => pakInput.focus(), 50);
    }
  });
}

function doUpload() {
  uploadAttempt = 0;
  const panel = document.getElementById("upload-panel");
  const log = document.getElementById("upload-log");
  log.textContent = "";
  panel.classList.remove("hidden");
  panel.className = "upload-panel";

  setUploadState("writing");

  // Send via WebSocket
  if (typeof ws !== "undefined" && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "start_upload" }));
  } else {
    appendUploadLog("Error: Not connected to server\n");
    setUploadState("failed");
  }
}

function confirmUpload(portalName, portalId) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">Deploy to HubSpot?</div>
        <p class="confirm-dialog__detail">
          Uploading to <strong>${esc(portalName)}</strong>${portalId ? ` (${esc(portalId)})` : ""}
          <button class="btn-link" id="confirm-upload-change">Change</button>
        </p>
        <div id="confirm-upload-switch" class="hidden" style="margin:12px 0"></div>
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" id="confirm-upload-cancel">Cancel</button>
          <button class="btn btn--primary" id="confirm-upload-go">Deploy</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };

    document.getElementById("confirm-upload-cancel").addEventListener("click", () => close(false));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.getElementById("confirm-upload-go").addEventListener("click", () => close(true));

    document.getElementById("confirm-upload-change").addEventListener("click", async () => {
      const switchArea = document.getElementById("confirm-upload-switch");
      if (!switchArea.classList.contains("hidden")) { switchArea.classList.add("hidden"); return; }
      switchArea.classList.remove("hidden");
      switchArea.innerHTML = '<span class="upload-spinner"></span> Loading accounts...';

      try {
        const res = await fetch("/api/settings/status");
        const data = await res.json();
        const accounts = data.config?.hubspotAccounts || [];
        const activeId = data.config?.activeHubSpotAccount;

        let html = '<div style="display:flex;flex-direction:column;gap:6px">';
        for (const acct of accounts) {
          const isActive = acct.portalId === activeId;
          html += `<button class="btn btn--${isActive ? "primary" : "secondary"} confirm-acct-btn" data-portal="${esc(acct.portalId)}" style="text-align:left;padding:6px 12px;font-size:13px">${esc(acct.portalName || acct.portalId)} (${esc(acct.portalId)})${isActive ? ' <span class="vs-icon-inline">' + vsIcon("check", {size: "sm"}) + '</span>' : ""}</button>`;
        }
        html += `<button class="btn btn--secondary confirm-acct-btn" data-portal="__new" style="text-align:left;padding:6px 12px;font-size:13px">+ Add another account</button>`;
        html += '</div>';
        switchArea.innerHTML = html;

        switchArea.querySelectorAll(".confirm-acct-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const pid = btn.dataset.portal;
            if (pid === "__new") {
              close(false);
              const added = await showHubSpotSetupDialog("auth");
              if (added) startUpload();
              return;
            }
            if (pid === activeId) { switchArea.classList.add("hidden"); return; }
            // Switch active account
            await fetch("/api/settings/hs-switch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ portalId: pid }),
            });
            // Restart the deploy flow with the new account
            close(false);
            startUpload();
          });
        });
      } catch {
        switchArea.innerHTML = '<span style="color:var(--error)">Failed to load accounts</span>';
      }
    });
  });
}

function setUploadState(state, data) {
  uploadState = state;
  const panel = document.getElementById("upload-panel");
  const statusEl = document.getElementById("upload-status-text");
  const actions = document.getElementById("upload-actions");
  const uploadBtn = document.getElementById("btn-upload");

  // Reset panel state classes
  panel.className = "upload-panel";
  actions.innerHTML = "";

  switch (state) {
    case "idle":
      panel.classList.add("hidden");
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = false;
      }
      break;

    case "writing":
      statusEl.textContent = "Writing files to disk...";
      if (uploadBtn) {
        uploadBtn.innerHTML = '<span class="upload-spinner"></span> Preparing...';
        uploadBtn.disabled = true;
      }
      break;

    case "autofix":
      statusEl.textContent = "Applying auto-fixes...";
      break;

    case "uploading":
      panel.classList.add("upload-panel--uploading");
      statusEl.textContent = "Uploading to HubSpot" + (uploadAttempt > 1 ? ` (attempt ${uploadAttempt})` : "") + "...";
      if (uploadBtn) {
        uploadBtn.innerHTML = '<span class="upload-spinner"></span> Uploading...';
        uploadBtn.disabled = true;
      }
      break;

    case "success":
      panel.classList.add("upload-panel--success");
      statusEl.innerHTML = '<span class="upload-status-icon">' + vsIcon("check-circle", {size: "sm"}) + '</span> Upload complete!';
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = true;
      }
      const dismissBtn = document.createElement("button");
      dismissBtn.className = "upload-action-btn";
      dismissBtn.textContent = "Dismiss";
      dismissBtn.addEventListener("click", () => setUploadState("idle"));
      actions.appendChild(dismissBtn);

      if (lastUploadPortalId) {
        const isEmail = lastUploadContentMode === "email";
        const createBtn = document.createElement("button");
        createBtn.className = "upload-action-btn upload-action-btn--primary";
        createBtn.textContent = isEmail ? "Create Email in HubSpot" : "Create Page in HubSpot";
        createBtn.addEventListener("click", () => {
          const url = isEmail
            ? buildHubSpotEmailUrl(lastUploadPortalId, lastUploadDataCenter)
            : buildHubSpotPagesUrl(lastUploadPortalId, lastUploadDataCenter);
          window.open(url, "_blank");
        });
        actions.insertBefore(createBtn, dismissBtn);
      }
      break;

    case "failed":
      panel.classList.add("upload-panel--error");
      statusEl.innerHTML = '<span class="upload-status-icon">' + vsIcon("x-circle", {size: "sm"}) + '</span> Upload failed';
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = true;
      }

      const retryBtn = document.createElement("button");
      retryBtn.className = "upload-action-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => startUpload());
      actions.appendChild(retryBtn);

      const fixBtn = document.createElement("button");
      fixBtn.className = "upload-action-btn upload-action-btn--primary";
      fixBtn.textContent = "Fix with AI";
      fixBtn.addEventListener("click", () => fixUploadWithAI());
      actions.appendChild(fixBtn);

      const dismissFailBtn = document.createElement("button");
      dismissFailBtn.className = "upload-action-btn";
      dismissFailBtn.textContent = "Dismiss";
      dismissFailBtn.addEventListener("click", () => setUploadState("idle"));
      actions.appendChild(dismissFailBtn);
      break;

    case "ai_fixing":
      panel.classList.add("upload-panel--fixing");
      statusEl.innerHTML = '<span class="upload-spinner"></span> AI is fixing errors...';
      if (uploadBtn) {
        uploadBtn.innerHTML = '<span class="upload-spinner"></span> Fixing...';
        uploadBtn.disabled = true;
      }
      break;

    case "fix_done":
      panel.classList.add("upload-panel--fixing");
      statusEl.innerHTML = '<span class="upload-status-icon">' + vsIcon("check-circle", {size: "sm"}) + '</span> AI fixes applied';
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = true;
      }

      const redeployBtn = document.createElement("button");
      redeployBtn.className = "upload-action-btn upload-action-btn--primary";
      redeployBtn.textContent = "Re-deploy";
      redeployBtn.addEventListener("click", () => startUpload());
      actions.appendChild(redeployBtn);

      const dismissFixBtn = document.createElement("button");
      dismissFixBtn.className = "upload-action-btn";
      dismissFixBtn.textContent = "Dismiss";
      dismissFixBtn.addEventListener("click", () => setUploadState("idle"));
      actions.appendChild(dismissFixBtn);
      break;
  }
}

let _logBuffer = "";
let _logFlushScheduled = false;

function appendUploadLog(text) {
  _logBuffer += text;
  if (!_logFlushScheduled) {
    _logFlushScheduled = true;
    requestAnimationFrame(() => {
      _logFlushScheduled = false;
      const log = document.getElementById("upload-log");
      if (log) {
        log.textContent += _logBuffer;
        log.scrollTop = log.scrollHeight;
      }
      _logBuffer = "";
    });
  }
}

function fixUploadWithAI() {
  const log = document.getElementById("upload-log");
  const errorContext = log ? log.textContent.slice(-2000) : "";

  // Show a verbose summary of what's happening
  appendUploadLog("\n\n========================================\n");
  appendUploadLog("  AI FIX — Analyzing upload errors\n");
  appendUploadLog("========================================\n\n");

  if (lastUploadErrors.length > 0) {
    appendUploadLog("Errors detected:\n");
    lastUploadErrors.forEach((e, i) => {
      appendUploadLog(`  ${i + 1}. ${e.message}\n`);
      appendUploadLog(`     File: ${e.file}\n`);
      if (e.fixable) {
        appendUploadLog("     Status: Auto-fixable — AI will patch this\n");
      } else {
        appendUploadLog("     Status: Requires AI analysis\n");
      }
    });
    appendUploadLog("\n");
  }

  appendUploadLog("Sending errors to AI for diagnosis and repair...\n\n");

  setUploadState("ai_fixing");

  if (typeof ws !== "undefined" && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "upload_fix_with_ai", errorContext }));
  }
}

function handleUploadWsMessage(msg) {
  switch (msg.type) {
    case "upload_status":
      if (msg.phase === "autofix" && msg.fixes?.length > 0) {
        setUploadState("autofix");
        appendUploadLog("Auto-fixes applied:\n");
        msg.fixes.forEach((f) => appendUploadLog("  \u2713 " + f + "\n"));
        appendUploadLog("\n");
      }
      break;

    case "upload_started":
      uploadAttempt++;
      setUploadState("uploading");
      break;

    case "upload_progress":
      if (msg.completed !== undefined && msg.total) {
        const pct = Math.round((msg.completed / msg.total) * 100);
        const statusEl = document.getElementById("upload-status-text");
        if (statusEl) {
          statusEl.textContent = `Uploading to HubSpot... ${msg.completed}/${msg.total} files (${pct}%)`;
        }
      }
      break;

    case "upload_output":
      appendUploadLog(msg.chunk);
      break;

    case "upload_complete":
      lastUploadContentMode = msg.contentMode || "page";
      setUploadState("success");
      // Update status bar
      const statusText = document.getElementById("status-text");
      if (statusText) statusText.textContent = "Upload complete!";
      // Show celebration popup
      showDeploySuccessPopup(msg.portalId, msg.dataCenter || "na1", msg.themeName, lastUploadContentMode);
      break;

    case "upload_failed":
      lastUploadErrors = msg.errors || [];
      setUploadState("failed", { errors: msg.errors });
      appendUploadLog("\n--- Upload failed ---\n\n");
      if (msg.errors && msg.errors.length > 0) {
        appendUploadLog(`${msg.errors.length} error(s) found:\n`);
        msg.errors.forEach((e, i) => {
          appendUploadLog(`  ${i + 1}. \u2717 ${e.message}\n`);
          appendUploadLog(`     File: ${e.file}\n`);
        });
      } else {
        appendUploadLog("  Check the log above for details.\n");
      }
      appendUploadLog("\nClick \"Fix with AI\" to automatically diagnose and repair these issues.\n");
      break;

    case "upload_fix_started":
      setUploadState("ai_fixing");
      break;

    case "upload_fix_stream":
      // AI fix explanation streamed into the upload panel
      appendUploadLog(msg.content || "");
      break;

    case "upload_fix_complete":
      appendUploadLog("\n\n========================================\n");
      appendUploadLog("  Fix complete\n");
      appendUploadLog("========================================\n");
      lastUploadErrors = [];
      setUploadState("fix_done");
      break;
  }
}

function buildHubSpotPagesUrl(portalId, dataCenter) {
  const host = dataCenter === "eu1" ? "app-eu1.hubspot.com" : "app.hubspot.com";
  return `https://${host}/page-ui/${portalId}/management/pages/landing`;
}

function buildHubSpotEmailUrl(portalId, dataCenter) {
  const host = dataCenter === "eu1" ? "app-eu1.hubspot.com" : "app.hubspot.com";
  return `https://${host}/email/${portalId}`;
}

function showDeploySuccessPopup(portalId, dataCenter, themeName, contentMode) {
  lastUploadPortalId = portalId || "";
  lastUploadDataCenter = dataCenter || "na1";
  lastUploadThemeName = themeName || "";

  const name = themeName || "your theme";
  const isEmail = contentMode === "email";

  // Spawn confetti
  spawnConfetti();

  let stepsHtml, actionUrl, actionLabel;
  if (isEmail) {
    actionUrl = portalId ? buildHubSpotEmailUrl(portalId, dataCenter) : "";
    actionLabel = "Create Email in HubSpot";
    stepsHtml = `
      <div class="deploy-success__step"><span class="deploy-success__num">1</span> Go to <strong>Marketing &rarr; Email</strong></div>
      <div class="deploy-success__step"><span class="deploy-success__num">2</span> Click <strong>"Create email"</strong></div>
      <div class="deploy-success__step"><span class="deploy-success__num">3</span> Select your <strong>"${esc(name)}"</strong> template</div>
    `;
  } else {
    const lpLabel = `${name} Landing Page`;
    actionUrl = portalId ? buildHubSpotPagesUrl(portalId, dataCenter) : "";
    actionLabel = "Create Page in HubSpot";
    stepsHtml = `
      <div class="deploy-success__step"><span class="deploy-success__num">1</span> Go to <strong>Content &rarr; Landing Pages</strong></div>
      <div class="deploy-success__step"><span class="deploy-success__num">2</span> Click <strong>"Create" &rarr; "Landing page"</strong></div>
      <div class="deploy-success__step"><span class="deploy-success__num">3</span> Select the <strong>"${esc(lpLabel)}"</strong> template</div>
    `;
  }

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="deploy-success">
      <div class="deploy-success__icon">${vsIcon("rocket", {size: "md"})}</div>
      <h2 class="deploy-success__title">${isEmail ? "Email template deployed!" : "Theme deployed!"}</h2>
      <p class="deploy-success__subtitle">"${esc(name)}" is now live on HubSpot.</p>
      <div class="deploy-success__steps">
        ${stepsHtml}
      </div>
      <div class="deploy-success__actions">
        ${actionUrl ? `<a href="${actionUrl}" target="_blank" class="btn btn--primary deploy-success__link">${actionLabel} &rarr;</a>` : ""}
        <button class="btn btn--secondary" id="deploy-success-dismiss">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("deploy-success-dismiss").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function spawnConfetti() {
  const colors = ["#e8613a", "#f2825f", "#4ade80", "#f59e0b", "#818cf8", "#fb7185"];
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:10000;overflow:hidden";
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.6;
    const size = 6 + Math.random() * 6;
    const drift = (Math.random() - 0.5) * 120;
    piece.style.cssText = `
      position:absolute;top:-10px;left:${left}%;
      width:${size}px;height:${size * 0.6}px;
      background:${color};border-radius:2px;
      animation:confettiFall ${1.8 + Math.random() * 1.2}s ease-out ${delay}s forwards;
      --drift:${drift}px;
    `;
    container.appendChild(piece);
  }

  // Inject keyframes once
  if (!document.getElementById("confetti-style")) {
    const style = document.createElement("style");
    style.id = "confetti-style";
    style.textContent = `
      @keyframes confettiFall {
        0% { transform: translateY(0) translateX(0) rotate(0deg); opacity: 1; }
        100% { transform: translateY(100vh) translateX(var(--drift)) rotate(720deg); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => container.remove(), 4000);
}

// Toggle panel collapse
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("upload-panel-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const log = document.getElementById("upload-log");
      if (log) log.classList.toggle("collapsed");
      toggle.classList.toggle("flipped");
    });
  }
});
