const titleEl = document.getElementById("title");
const contentEl = document.getElementById("content");

function isTwitterUrl(url) {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return u.hostname === "x.com" || u.hostname === "twitter.com";
  } catch {
    return false;
  }
}

function isTwitterBookmarksPage(url) {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return isTwitterUrl(u) && u.pathname.startsWith("/i/bookmarks");
  } catch {
    return false;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  if (isTwitterUrl(url)) {
    titleEl.textContent = "Twitter Spike";
    initTwitter(tab);
    return;
  }

  titleEl.textContent = "Farcaster Bookmarks";

  if (!FarcasterAdapter.canHandle(url)) {
    contentEl.innerHTML = `
      <div class="not-on-fc">
        <p>Navigate to <strong>farcaster.xyz</strong> or <strong>x.com/i/bookmarks</strong> and reopen this popup.</p>
      </div>`;
    return;
  }

  const onBookmarks = FarcasterAdapter.isBookmarksPage(url);

  contentEl.innerHTML = `
    ${!onBookmarks ? '<p style="font-size:12px;color:#b45309">You\'re on Farcaster but not the bookmarks page. Navigate to /~/bookmarks for best results.</p>' : ""}
    <button id="exportBtn">Export Bookmarks</button>
    <button id="archiveBtn" style="margin-top:8px;background:#f3f4f6;color:#111827">Open Archive</button>
    <div id="status"></div>
    <div id="diagnostics"></div>`;

  document.getElementById("exportBtn").addEventListener("click", () => runFarcasterExport(tab.id));
  document.getElementById("archiveBtn").addEventListener("click", () => openArchive(tab.id));
}

function initTwitter(tab) {
  const onBookmarks = isTwitterBookmarksPage(tab.url || "");
  contentEl.innerHTML = `
    ${!onBookmarks ? '<p style="font-size:12px;color:#b45309">Open <strong>x.com/i/bookmarks</strong> or <strong>twitter.com/i/bookmarks</strong>, then scroll to trigger the bookmark timeline request.</p>' : ""}
    <button id="syncBtn">Sync Bookmarks</button>
    <button id="probeBtn">Read Spike</button>
    <button id="archiveBtn" style="margin-top:8px;background:#f3f4f6;color:#111827">Open Archive</button>
    <div id="status"></div>
    <div id="diagnostics"></div>`;

  document.getElementById("syncBtn").addEventListener("click", () => runTwitterSync(tab.id));
  document.getElementById("probeBtn").addEventListener("click", () => runTwitterSpike(tab.id));
  document.getElementById("archiveBtn").addEventListener("click", () => openArchive(tab.id));
  runTwitterSpike(tab.id, { silent: true });
}

async function openArchive(tabId) {
  await chrome.sidePanel.open({ tabId });
  window.close();
}

async function runTwitterSpike(tabId, { silent = false } = {}) {
  const btn = document.getElementById("probeBtn");
  const status = document.getElementById("status");
  const diagEl = document.getElementById("diagnostics");

  if (btn) btn.disabled = true;
  if (!silent) {
    status.className = "";
    status.textContent = "Reading spike state...";
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const spike = window.__TWITTER_BOOKMARK_SPIKE__;
        if (!spike) return null;
        return {
          startedAt: spike.startedAt || null,
          ready: !!spike.ready,
          matchedUrls: spike.matchedUrls || 0,
          transports: spike.transports || {},
          lastError: spike.lastError || null,
          latest: Array.isArray(spike.events) && spike.events.length > 0 ? spike.events[0] : null,
        };
      },
    });

    const data = results?.[0]?.result;
    if (!data) {
      status.className = "error";
      status.textContent = "Twitter spike script not loaded on this page.";
      diagEl.textContent = "";
      return;
    }

    if (!data.ready || !data.latest) {
      status.className = "";
      status.textContent = "No bookmark traffic captured yet. Open the bookmarks page and scroll.";
      diagEl.textContent = data.startedAt ? `probe active since ${new Date(data.startedAt).toLocaleTimeString()}` : "";
      return;
    }

    status.className = "success";
    status.textContent = `Captured ${data.matchedUrls} bookmark response${data.matchedUrls !== 1 ? "s" : ""}.`;
    showTwitterDiag(diagEl, data);
  } catch (e) {
    status.className = "error";
    status.textContent = `Error: ${e.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runTwitterSync(tabId) {
  const btn = document.getElementById("syncBtn");
  const status = document.getElementById("status");
  const diagEl = document.getElementById("diagnostics");

  btn.disabled = true;
  status.className = "";
  status.textContent = "Reading captured bookmark responses...";

  try {
    const result = await TwitterAdapter.exportAll(tabId);

    if (result.error) {
      status.className = "error";
      status.textContent = result.error;
      showTwitterDiag(diagEl, { latest: null, lastError: null, ...result.diagnostics });
      return;
    }

    const syncResult = await chrome.runtime.sendMessage({
      type: "FC_SYNC_BOOKMARKS",
      platform: "twitter",
      items: result.items,
    });

    status.className = "success";
    status.textContent = `Synced ${syncResult.added} new bookmarks.`;
    showTwitterDiag(diagEl, {
      latest: {
        transport: result.diagnostics.transports?.xhr ? "xhr" : result.diagnostics.transports?.fetch ? "fetch" : null,
        entryCount: result.items.length,
      },
      ...result.diagnostics,
    });
  } catch (e) {
    status.className = "error";
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function showTwitterDiag(el, data) {
  const latest = data.latest || {};
  const parts = [];

  if (latest.transport) parts.push(`transport: ${latest.transport}`);
  if (latest.operation) parts.push(`op: ${latest.operation}`);
  if (latest.status !== undefined) parts.push(`status: ${latest.status}`);
  if (latest.hasBookmarkTimeline !== undefined) parts.push(`timeline: ${latest.hasBookmarkTimeline ? "yes" : "no"}`);
  if (latest.entryCount !== undefined) parts.push(`entries: ${latest.entryCount}`);
  if (latest.request?.cursor) parts.push(`cursor: yes`);
  if (Array.isArray(latest.instructionTypes) && latest.instructionTypes.length > 0) {
    parts.push(`instructions: ${latest.instructionTypes.join(", ")}`);
  }
  if (Array.isArray(latest.sampleTweetIds) && latest.sampleTweetIds.length > 0) {
    parts.push(`sample ids: ${latest.sampleTweetIds.join(", ")}`);
  }
  if (data.lastError?.message) {
    parts.push(`last error: ${data.lastError.message}`);
  }
  if (data.cachedTweets !== undefined) {
    parts.push(`cached: ${data.cachedTweets}`);
  }

  el.textContent = parts.join(" | ");
}

async function runFarcasterExport(tabId) {
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
      showFarcasterDiag(diagEl, result.diagnostics);
      return;
    }

    if (result.items.length === 0) {
      status.className = "error";
      status.textContent = "No bookmarks found. Are you logged in?";
      btn.disabled = false;
      showFarcasterDiag(diagEl, result.diagnostics);
      return;
    }

    status.textContent = `Collected ${result.items.length} bookmarks. Preparing download...`;

    const records = result.items.map((item) => normalizeStoredBookmark("farcaster", item, {
      savedAt: item.savedAt || item.saved_at || item.bookmarkedAt || item.timestamp || item.publishedAt || item.published_at || new Date().toISOString(),
      capturedVia: "sync",
    })).filter(Boolean);
    const payload = buildExportPayload(records, result.diagnostics);
    const filename = downloadJSON(payload);

    status.className = "success";
    status.textContent = `Exported ${result.items.length} bookmarks to ${filename}`;
    showFarcasterDiag(diagEl, result.diagnostics);
  } catch (e) {
    status.className = "error";
    status.textContent = `Error: ${e.message}`;
    btn.disabled = false;
  }
}

function showFarcasterDiag(el, diag) {
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
