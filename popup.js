const contentEl = document.getElementById("content");

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  if (!FarcasterAdapter.canHandle(url)) {
    contentEl.innerHTML = `
      <div class="not-on-fc">
        <p>Navigate to <strong>farcaster.xyz/~/bookmarks</strong> and reopen this popup.</p>
      </div>`;
    return;
  }

  const onBookmarks = FarcasterAdapter.isBookmarksPage(url);

  contentEl.innerHTML = `
    ${!onBookmarks ? '<p style="font-size:12px;color:#b45309">You\'re on Farcaster but not the bookmarks page. Navigate to /~/bookmarks for best results.</p>' : ""}
    <button id="exportBtn">Export Bookmarks</button>
    <div id="status"></div>
    <div id="diagnostics"></div>`;

  document.getElementById("exportBtn").addEventListener("click", () => runExport(tab.id));
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

    status.textContent = `Collected ${result.items.length} bookmarks. Preparing download...`;

    const payload = buildExportPayload(result.items, result.diagnostics);
    const filename = downloadJSON(payload);

    status.className = "success";
    status.textContent = `Exported ${result.items.length} bookmarks to ${filename}`;
    showDiag(diagEl, result.diagnostics);
  } catch (e) {
    status.className = "error";
    status.textContent = `Error: ${e.message}`;
    btn.disabled = false;
  }
}

function showDiag(el, diag) {
  if (!diag) return;
  const parts = [];
  if (diag.endpoint) parts.push(`endpoint: ${diag.endpoint}`);
  if (diag.pagesLoaded !== undefined) parts.push(`pages: ${diag.pagesLoaded}`);
  if (diag.itemsCollected !== undefined) parts.push(`items: ${diag.itemsCollected}`);
  if (diag.limitUsed) parts.push(`limit: ${diag.limitUsed}`);
  if (diag.arrayKey) parts.push(`key: ${diag.arrayKey}`);
  el.textContent = parts.join(" | ");
}

init();
