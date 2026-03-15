/**
 * Background service worker for Farcaster Bookmarks Exporter.
 *
 * Listens for bookmark events from content.js and stores them
 * in chrome.storage.local. Provides queries for the popup.
 *
 * Storage layout:
 *   "fc_bookmarks" - object keyed by cast hash, values are bookmark records
 *   "fc_meta"      - { last_sync, total_count, last_capture }
 */

const BOOKMARKS_KEY = "fc_bookmarks";
const META_KEY = "fc_meta";

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FC_BOOKMARK_ACTION") {
    handleBookmarkAction(message).then(sendResponse);
    return true; // async response
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

  if (message.type === "FC_CLEAR_BOOKMARKS") {
    clearBookmarks().then(sendResponse);
    return true;
  }
});

async function handleBookmarkAction(message) {
  const { action, castHash, castData, timestamp } = message;

  if (!castHash) {
    return { ok: false, reason: "no_cast_hash" };
  }

  const data = await chrome.storage.local.get([BOOKMARKS_KEY, META_KEY]);
  const bookmarks = data[BOOKMARKS_KEY] || {};
  const meta = data[META_KEY] || {};

  if (action === "remove") {
    delete bookmarks[castHash];
  } else {
    // add or update
    bookmarks[castHash] = {
      castHash,
      castData: castData || bookmarks[castHash]?.castData || null,
      saved_at: timestamp || new Date().toISOString(),
      captured_via: "live",
    };
  }

  meta.total_count = Object.keys(bookmarks).length;
  meta.last_capture = new Date().toISOString();

  await chrome.storage.local.set({
    [BOOKMARKS_KEY]: bookmarks,
    [META_KEY]: meta,
  });

  return { ok: true, action, castHash, total: meta.total_count };
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

    if (!bookmarks[hash]) {
      added++;
    }
    bookmarks[hash] = {
      castHash: hash,
      castData: item,
      saved_at: item.savedAt || item.saved_at || item.bookmarkedAt || new Date().toISOString(),
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
  await chrome.storage.local.remove([BOOKMARKS_KEY, META_KEY]);
  return { ok: true };
}
