/**
 * Background service worker.
 *
 * Platform-agnostic bookmark storage. Content scripts detect bookmark
 * actions per-platform and send FC_BOOKMARK_ACTION messages here.
 *
 * The side panel watches chrome.storage.onChanged for live updates,
 * so we don't need to coordinate runtime messages to it.
 *
 * Storage layout:
 *   "fc_bookmarks"   – object keyed by cast hash → bookmark record
 *   "fc_meta"        – { total_count, last_sync, last_capture }
 *   "fc_last_added"  – the most recently captured bookmark (for toast)
 */

const BOOKMARKS_KEY = "fc_bookmarks";
const META_KEY = "fc_meta";
const LAST_ADDED_KEY = "fc_last_added";
const LAST_REMOVED_KEY = "fc_last_removed";

// Open side panel when the extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── webRequest backup: detect bookmark API calls at the network level ──
// This fires even if the MAIN world fetch patch fails (race condition, overwrite, etc.)
// We can't read the POST body in MV3 webRequest, but we CAN detect the URL pattern
// and then ask the content script to check its cast cache for details.

const pendingWebRequests = new Map(); // requestId → { url, method, tabId, timestamp }

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method === "GET") return;
    const url = details.url.toLowerCase();
    if (url.includes("bookmark")) {
      pendingWebRequests.set(details.requestId, {
        url: details.url,
        method: details.method,
        tabId: details.tabId,
        timestamp: new Date().toISOString(),
        isRemove: url.includes("unbookmark") || url.includes("remove") || details.method === "DELETE",
      });
    }
  },
  { urls: ["https://farcaster.xyz/~/api/*", "https://farcaster.xyz/~api/*", "https://*.farcaster.xyz/*/api/*"] }
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const pending = pendingWebRequests.get(details.requestId);
    if (!pending) return;
    pendingWebRequests.delete(details.requestId);

    // Only act if the request succeeded
    if (details.statusCode < 200 || details.statusCode >= 400) return;

    // The MAIN world intercept should have already fired. Give it 500ms,
    // then check if we got a recent bookmark action. If not, ask the
    // content script to look up what happened.
    setTimeout(async () => {
      const data = await chrome.storage.local.get([META_KEY]);
      const meta = data[META_KEY] || {};
      const lastCapture = meta.last_capture ? new Date(meta.last_capture).getTime() : 0;
      const now = Date.now();

      // If we got a capture in the last 2 seconds, the fetch intercept handled it
      if (now - lastCapture < 2000) return;

      // Fetch intercept missed it — try to ask the content script for the cast hash
      try {
        const [response] = await chrome.tabs.sendMessage(pending.tabId, {
          type: "FC_WEBREQUEST_BACKUP",
          url: pending.url,
          isRemove: pending.isRemove,
          timestamp: pending.timestamp,
        }).catch(() => [null]);

        // If content script found a hash, it will relay FC_BOOKMARK_ACTION
        // Otherwise the bookmark is lost — but at least we tried both layers
      } catch (e) {
        // Tab might be closed or content script not loaded
      }
    }, 500);
  },
  { urls: ["https://farcaster.xyz/~/api/*", "https://farcaster.xyz/~api/*", "https://*.farcaster.xyz/*/api/*"] }
);

// Clean up stale pending requests periodically
setInterval(() => {
  const cutoff = Date.now() - 30000;
  for (const [id, req] of pendingWebRequests) {
    if (new Date(req.timestamp).getTime() < cutoff) pendingWebRequests.delete(id);
  }
}, 60000);

// Handle messages from content scripts and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FC_BOOKMARK_ACTION") {
    handleBookmarkAction(message).then(sendResponse);
    return true;
  }
  if (message.type === "FC_GET_STATS") {
    getStats().then(sendResponse);
    return true;
  }
  if (message.type === "FC_GET_ALL_BOOKMARKS") {
    getAllBookmarks().then(sendResponse);
    return true;
  }
  if (message.type === "FC_SYNC_BOOKMARKS") {
    syncBookmarks(message.items).then(sendResponse);
    return true;
  }
  if (message.type === "FC_DELETE_BOOKMARK") {
    deleteBookmark(message.castHash).then(sendResponse);
    return true;
  }
  if (message.type === "FC_CLEAR_BOOKMARKS") {
    clearBookmarks().then(sendResponse);
    return true;
  }
});

// Dedupe: both DOM and fetch layers may fire for the same action.
// Ignore duplicate actions for the same hash within 3 seconds.
const recentActions = new Map(); // castHash → timestamp

async function handleBookmarkAction(message) {
  const { action, castHash, castData, timestamp } = message;

  if (!castHash) {
    return { ok: false, reason: "no_cast_hash" };
  }

  // Deduplicate — same hash + same action within 3s = skip
  const dedupeKey = `${action}:${castHash}`;
  const lastTime = recentActions.get(dedupeKey);
  if (lastTime && Date.now() - lastTime < 3000) {
    // But if this message has richer cast data, update just the data
    if (castData && action !== "remove") {
      const data = await chrome.storage.local.get([BOOKMARKS_KEY]);
      const bookmarks = data[BOOKMARKS_KEY] || {};
      if (bookmarks[castHash] && !bookmarks[castHash].castData?.author && castData.author) {
        bookmarks[castHash].castData = castData;
        await chrome.storage.local.set({ [BOOKMARKS_KEY]: bookmarks });
      }
    }
    return { ok: true, action, castHash, deduplicated: true };
  }
  recentActions.set(dedupeKey, Date.now());
  // Clean old entries
  for (const [k, t] of recentActions) {
    if (Date.now() - t > 10000) recentActions.delete(k);
  }

  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};

  // Grab existing record before potential delete (for removal toast)
  const existingRecord = bookmarks[castHash] || null;

  if (action === "remove") {
    delete bookmarks[castHash];
  } else {
    bookmarks[castHash] = {
      castHash,
      castData: castData || bookmarks[castHash]?.castData || null,
      saved_at: timestamp || new Date().toISOString(),
      captured_via: "live",
    };
  }

  meta.total_count = Object.keys(bookmarks).length;
  meta.last_capture = new Date().toISOString();

  // Write bookmarks + meta + last_added in one call so the side panel
  // gets a single storage.onChanged event it can react to
  const updates = {
    [BOOKMARKS_KEY]: bookmarks,
    [META_KEY]: meta,
  };

  if (action === "remove") {
    updates[LAST_REMOVED_KEY] = {
      castHash,
      castData: existingRecord?.castData || castData || null,
      _ts: Date.now(),
    };
  } else {
    updates[LAST_ADDED_KEY] = {
      castHash,
      castData: castData || null,
      saved_at: timestamp || new Date().toISOString(),
      captured_via: "live",
      _ts: Date.now(),  // ensure storage sees a change even for re-bookmarks
    };
  }

  await chrome.storage.local.set(updates);

  return { ok: true, action, castHash, total: meta.total_count };
}

async function deleteBookmark(castHash) {
  if (!castHash) return { ok: false, reason: "no_cast_hash" };

  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};

  delete bookmarks[castHash];
  meta.total_count = Object.keys(bookmarks).length;

  await chrome.storage.local.set({
    [BOOKMARKS_KEY]: bookmarks,
    [META_KEY]: meta,
  });

  return { ok: true, total: meta.total_count };
}

async function getStats() {
  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};
  return {
    total: Object.keys(bookmarks).length,
    last_sync: meta.last_sync || null,
    last_capture: meta.last_capture || null,
  };
}

async function getAllBookmarks() {
  const data = await chrome.storage.local.get([BOOKMARKS_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  return { bookmarks };
}

async function syncBookmarks(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: "no_items" };
  }

  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};
  let added = 0;

  for (const item of items) {
    const hash = item.hash || item.castHash || item.cast_hash;
    if (!hash) continue;
    if (!bookmarks[hash]) added++;
    bookmarks[hash] = {
      castHash: hash,
      castData: item,
      saved_at: item.savedAt || item.saved_at || item.bookmarkedAt || item.timestamp || item.publishedAt || item.published_at || new Date().toISOString(),
      captured_via: "sync",
    };
  }

  meta.total_count = Object.keys(bookmarks).length;
  meta.last_sync = new Date().toISOString();

  await chrome.storage.local.set({
    [BOOKMARKS_KEY]: bookmarks,
    [META_KEY]: meta,
  });

  return { ok: true, added, total: meta.total_count };
}

async function clearBookmarks() {
  await chrome.storage.local.remove([BOOKMARKS_KEY, META_KEY, LAST_ADDED_KEY, LAST_REMOVED_KEY]);
  return { ok: true };
}
