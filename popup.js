const contentEl = document.getElementById("content");

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  // Always show storage stats, even if not on Farcaster
  const stats = await chrome.runtime.sendMessage({ type: "FC_GET_STATS" });

  if (!FarcasterAdapter.canHandle(url)) {
    contentEl.innerHTML = `
      <div id="stats">
        <div>Stored bookmarks: <span class="count">${stats?.total || 0}</span></div>
        ${stats?.last_sync ? `<div class="meta">Last sync: ${formatTime(stats.last_sync)}</div>` : ""}
        ${stats?.last_capture ? `<div class="meta">Last capture: ${formatTime(stats.last_capture)}</div>` : ""}
      </div>
      ${stats?.total > 0 ? '<button id="exportStoredBtn">Export from Storage</button>' : ""}
      <div class="not-on-fc">
        <p>Navigate to <strong>farcaster.xyz/~/bookmarks</strong> to sync or export via API.</p>
      </div>
      <div id="status"></div>`;

    if (stats?.total > 0) {
      document.getElementById("exportStoredBtn").addEventListener("click", () => exportFromStorage());
    }
    return;
  }

  const onBookmarks = FarcasterAdapter.isBookmarksPage(url);

  contentEl.innerHTML = `
    <div id="stats">
      <div>Stored bookmarks: <span class="count">${stats?.total || 0}</span></div>
      ${stats?.last_sync ? `<div class="meta">Last sync: ${formatTime(stats.last_sync)}</div>` : ""}
      ${stats?.last_capture ? `<div class="meta">Last capture: ${formatTime(stats.last_capture)}</div>` : ""}
    </div>
    ${!onBookmarks ? '<p style="font-size:12px;color:#b45309">You\'re on Farcaster but not the bookmarks page. Navigate to /~/bookmarks for best results.</p>' : ""}
    <button id="exportBtn">Export Bookmarks (API)</button>
    ${stats?.total > 0 ? '<button id="exportStoredBtn" class="secondary">Export from Storage</button>' : ""}
    <button id="syncBtn" class="secondary">Sync Now (API to Storage)</button>
    <div id="status"></div>
    <div id="diagnostics"></div>`;

  document.getElementById("exportBtn").addEventListener("click", () => runExport(tab.id));
  document.getElementById("syncBtn").addEventListener("click", () => runSync(tab.id));

  const exportStoredBtn = document.getElementById("exportStoredBtn");
  if (exportStoredBtn) {
    exportStoredBtn.addEventListener("click", () => exportFromStorage());
  }
}

async function runExport(tabId) {
  const btn = document.getElementById("exportBtn");
  const status = document.getElementById("status");
  const diagEl = document.getElementById("diagnostics");

  btn.disabled = true;
  status.className = "";
  status.textContent = "Discovering API endpoint (this may take a few seconds)...";

  try {
    const result = await FarcasterAdapter.exportAll(tabId);

    if (result.error) {
      status.className = "error";
      status.textContent = result.error;
      btn.disabled = false;
      showDiag(diagEl, result.diagnostics);
      return;
    }

    if (result.items.length === 0) {
      status.className = "error";
      status.textContent = "No bookmarks found. Are you logged in?";
      btn.disabled = false;
      showDiag(diagEl, result.diagnostics);
      return;
    }

    // Also save to storage
    chrome.runtime.sendMessage({
      type: "FC_SYNC_BOOKMARKS",
      items: result.items,
    });

    status.textContent = `Collected ${result.items.length} bookmarks. Preparing download...`;

    const payload = buildExportPayload(result.items, result.diagnostics);
    const filename = downloadJSON(payload);

    status.className = "success";
    status.textContent = `Exported ${result.items.length} bookmarks to ${filename}`;
    showDiag(diagEl, result.diagnostics);
    refreshStats();
  } catch (e) {
    status.className = "error";
    status.textContent = `Error: ${e.message}`;
    btn.disabled = false;
  }
}

async function runSync(tabId) {
  const btn = document.getElementById("syncBtn");
  const status = document.getElementById("status");
  const diagEl = document.getElementById("diagnostics");

  btn.disabled = true;
  status.className = "";
  status.textContent = "Syncing bookmarks from API to storage...";

  try {
    const result = await FarcasterAdapter.exportAll(tabId);

    if (result.error) {
      status.className = "error";
      status.textContent = result.error;
      btn.disabled = false;
      showDiag(diagEl, result.diagnostics);
      return;
    }

    if (result.items.length === 0) {
      status.className = "error";
      status.textContent = "No bookmarks found from API.";
      btn.disabled = false;
      return;
    }

    const syncResult = await chrome.runtime.sendMessage({
      type: "FC_SYNC_BOOKMARKS",
      items: result.items,
    });

    status.className = "success";
    status.textContent = `Synced! ${syncResult.added} new, ${syncResult.total} total in storage.`;
    showDiag(diagEl, result.diagnostics);
    btn.disabled = false;
    refreshStats();
  } catch (e) {
    status.className = "error";
    status.textContent = `Sync error: ${e.message}`;
    btn.disabled = false;
  }
}

async function exportFromStorage() {
  const status = document.getElementById("status");
  status.className = "";
  status.textContent = "Loading bookmarks from storage...";

  try {
    const result = await chrome.runtime.sendMessage({ type: "FC_GET_ALL_BOOKMARKS" });
    const bookmarks = result?.bookmarks || {};
    const items = Object.values(bookmarks).map((b) => b.castData).filter(Boolean);

    if (items.length === 0) {
      status.className = "error";
      status.textContent = "No bookmark data in storage.";
      return;
    }

    const payload = buildExportPayload(items, { fallbackUsed: false });
    const filename = downloadJSON(payload);

    status.className = "success";
    status.textContent = `Exported ${items.length} bookmarks from storage to ${filename}`;
  } catch (e) {
    status.className = "error";
    status.textContent = `Export error: ${e.message}`;
  }
}

async function refreshStats() {
  const stats = await chrome.runtime.sendMessage({ type: "FC_GET_STATS" });
  const countEl = document.querySelector("#stats .count");
  if (countEl) countEl.textContent = stats?.total || 0;
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function showDiag(el, diag) {
  if (!el || !diag) return;
  const parts = [];
  if (diag.endpoint) parts.push(`endpoint: ${diag.endpoint}`);
  if (diag.pagesLoaded !== undefined) parts.push(`pages: ${diag.pagesLoaded}`);
  if (diag.itemsCollected !== undefined) parts.push(`items: ${diag.itemsCollected}`);
  if (diag.limitUsed) parts.push(`limit: ${diag.limitUsed}`);
  if (diag.arrayKey) parts.push(`key: ${diag.arrayKey}`);
  el.textContent = parts.join(" | ");
}

init();
