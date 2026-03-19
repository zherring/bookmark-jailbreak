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

// Let the toolbar action show the popup. The side panel remains available
// via the popup's "Open Archive" button.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

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
  if (message.type === "FC_TWITTER_BOOKMARK_ACTION") {
    handleTwitterBookmarkAction(message).then(sendResponse);
    return true;
  }
  if (message.type === "FC_TWITTER_BOOKMARK_ENRICH") {
    enrichTwitterBookmark(message).then(sendResponse);
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
    syncBookmarks(message.items, message.platform).then(sendResponse);
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

function makeBookmarkId(platform, itemId) {
  return `${platform}:${itemId}`;
}

function parseTwitterDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function extractTwitterTweet(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.__typename === "TweetWithVisibilityResults" && raw.tweet?.rest_id) return raw.tweet;
  if (raw.__typename === "Tweet" && raw.rest_id) return raw;
  if (raw.rest_id && raw.legacy) return raw;
  if (raw.tweet?.rest_id) return raw.tweet;
  if (raw.result) return extractTwitterTweet(raw.result);
  return null;
}

function normalizeStoredBookmark(platform, item, options = {}) {
  if (!item) return null;

  if (platform === "twitter") {
    const tweet = extractTwitterTweet(item);
    const itemId = tweet?.rest_id || item?.rest_id || item?.legacy?.id_str || null;
    if (!itemId) return null;
    const publishedAt = parseTwitterDate(tweet?.legacy?.created_at);
    return {
      id: makeBookmarkId("twitter", itemId),
      platform: "twitter",
      itemId,
      rawData: tweet || item,
      saved_at: options.savedAt || publishedAt || new Date().toISOString(),
      published_at: publishedAt,
      captured_via: options.capturedVia || "sync",
    };
  }

  const itemId = item.hash || item.castHash || item.cast_hash || null;
  if (!itemId) return null;
  return {
    id: makeBookmarkId("farcaster", itemId),
    platform: "farcaster",
    itemId,
    castHash: itemId,
    rawData: item,
    saved_at: options.savedAt || item.savedAt || item.saved_at || item.bookmarkedAt || item.timestamp || new Date().toISOString(),
    published_at: item.timestamp || item.publishedAt || item.published_at || null,
    captured_via: options.capturedVia || "sync",
  };
}

function getExistingRecord(bookmarks, platform, itemId) {
  if (!itemId) return null;
  const id = makeBookmarkId(platform, itemId);
  return bookmarks[id] || (platform === "farcaster" ? bookmarks[itemId] : null) || null;
}

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
      const bookmarkId = makeBookmarkId("farcaster", castHash);
      const existing = bookmarks[bookmarkId] || bookmarks[castHash];
      if (existing && !existing.rawData?.author && castData.author) {
        existing.rawData = castData;
        existing.castData = castData;
        bookmarks[bookmarkId] = existing;
        delete bookmarks[castHash];
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
  const bookmarkId = makeBookmarkId("farcaster", castHash);

  // Grab existing record before potential delete (for removal toast)
  const existingRecord = bookmarks[bookmarkId] || bookmarks[castHash] || null;

  if (action === "remove") {
    delete bookmarks[bookmarkId];
    delete bookmarks[castHash];
  } else {
    const record = normalizeStoredBookmark("farcaster", castData || existingRecord?.rawData || { hash: castHash }, {
      savedAt: timestamp || existingRecord?.saved_at || new Date().toISOString(),
      capturedVia: "live",
    });
    bookmarks[bookmarkId] = {
      ...record,
      castHash,
      castData: record.rawData,
    };
    delete bookmarks[castHash];
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
      id: bookmarkId,
      platform: "farcaster",
      itemId: castHash,
      castHash,
      rawData: existingRecord?.rawData || castData || null,
      castData: existingRecord?.rawData || castData || null,
      _ts: Date.now(),
    };
  } else {
    updates[LAST_ADDED_KEY] = {
      id: bookmarkId,
      platform: "farcaster",
      itemId: castHash,
      castHash,
      rawData: castData || null,
      castData: castData || null,
      saved_at: timestamp || new Date().toISOString(),
      captured_via: "live",
      _ts: Date.now(),  // ensure storage sees a change even for re-bookmarks
    };
  }

  await chrome.storage.local.set(updates);

  return { ok: true, action, castHash, total: meta.total_count };
}

async function handleTwitterBookmarkAction(message) {
  const { action, itemId, rawData, timestamp } = message;
  if (!itemId) return { ok: false, reason: "no_item_id" };

  const dedupeKey = `twitter:${action}:${itemId}`;
  const lastTime = recentActions.get(dedupeKey);
  if (lastTime && Date.now() - lastTime < 3000) {
    if (rawData && action !== "remove") {
      const data = await chrome.storage.local.get([BOOKMARKS_KEY]);
      const bookmarks = data[BOOKMARKS_KEY] || {};
      const bookmarkId = makeBookmarkId("twitter", itemId);
      if (bookmarks[bookmarkId] && !bookmarks[bookmarkId].rawData?.core?.user_results && rawData.core?.user_results) {
        bookmarks[bookmarkId].rawData = rawData;
        await chrome.storage.local.set({ [BOOKMARKS_KEY]: bookmarks });
      }
    }
    return { ok: true, action, itemId, deduplicated: true };
  }
  recentActions.set(dedupeKey, Date.now());
  for (const [k, t] of recentActions) {
    if (Date.now() - t > 10000) recentActions.delete(k);
  }

  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};
  const bookmarkId = makeBookmarkId("twitter", itemId);
  const existingRecord = bookmarks[bookmarkId] || null;

  if (action === "remove") {
    delete bookmarks[bookmarkId];
  } else {
    const fallbackRaw = rawData || existingRecord?.rawData || {
      __typename: "Tweet",
      rest_id: itemId,
      legacy: { id_str: itemId, full_text: "" },
    };
    const record = normalizeStoredBookmark("twitter", fallbackRaw, {
      savedAt: timestamp || existingRecord?.saved_at || new Date().toISOString(),
      capturedVia: "live",
    });
    bookmarks[bookmarkId] = {
      ...existingRecord,
      ...record,
      saved_at: existingRecord?.saved_at || record.saved_at,
    };
  }

  meta.total_count = Object.keys(bookmarks).length;
  meta.last_capture = new Date().toISOString();

  const updates = {
    [BOOKMARKS_KEY]: bookmarks,
    [META_KEY]: meta,
  };

  if (action === "remove") {
    updates[LAST_REMOVED_KEY] = {
      id: bookmarkId,
      platform: "twitter",
      itemId,
      rawData: existingRecord?.rawData || rawData || null,
      _ts: Date.now(),
    };
  } else {
    updates[LAST_ADDED_KEY] = {
      id: bookmarkId,
      platform: "twitter",
      itemId,
      rawData: rawData || existingRecord?.rawData || null,
      saved_at: timestamp || new Date().toISOString(),
      captured_via: "live",
      _ts: Date.now(),
    };
  }

  await chrome.storage.local.set(updates);
  return { ok: true, action, itemId, total: meta.total_count };
}

async function enrichTwitterBookmark(message) {
  const { itemId, rawData } = message;
  if (!itemId || !rawData) return { ok: false, reason: "missing_payload" };

  const data = await chrome.storage.local.get([BOOKMARKS_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const bookmarkId = makeBookmarkId("twitter", itemId);
  const existing = bookmarks[bookmarkId];
  if (!existing) return { ok: false, reason: "not_found" };

  const hasAuthor = !!existing.rawData?.core?.user_results;
  const hasText = !!existing.rawData?.legacy?.full_text;
  if (hasAuthor && hasText) return { ok: true, skipped: true };

  const record = normalizeStoredBookmark("twitter", rawData, {
    savedAt: existing.saved_at,
    capturedVia: existing.captured_via || "live",
  });
  if (!record) return { ok: false, reason: "normalize_failed" };

  bookmarks[bookmarkId] = {
    ...existing,
    ...record,
    saved_at: existing.saved_at || record.saved_at,
  };

  await chrome.storage.local.set({ [BOOKMARKS_KEY]: bookmarks });
  return { ok: true, enriched: true };
}

async function deleteBookmark(bookmarkId) {
  if (!bookmarkId) return { ok: false, reason: "no_bookmark_id" };

  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};

  delete bookmarks[bookmarkId];
  if (bookmarkId.startsWith("farcaster:")) {
    delete bookmarks[bookmarkId.slice("farcaster:".length)];
  }
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

async function syncBookmarks(items, platformHint) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: "no_items" };
  }

  const platform = platformHint || (items[0]?.rest_id || items[0]?.legacy?.full_text ? "twitter" : "farcaster");
  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};
  let added = 0;
  const baseTime = Date.now();

  for (const [index, item] of items.entries()) {
    const fallbackSavedAt = new Date(baseTime - index).toISOString();
    const record = normalizeStoredBookmark(platform, item, {
      savedAt: fallbackSavedAt,
      capturedVia: "sync",
    });
    if (!record) continue;

    const existing = getExistingRecord(bookmarks, record.platform, record.itemId);
    if (!existing) added++;

    bookmarks[record.id] = {
      ...existing,
      ...record,
      saved_at: existing?.saved_at || record.saved_at,
    };

    if (record.platform === "farcaster") {
      bookmarks[record.id].castHash = record.itemId;
      bookmarks[record.id].castData = record.rawData;
      delete bookmarks[record.itemId];
    }
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
