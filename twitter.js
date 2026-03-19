/**
 * Twitter/X bookmarks adapter.
 *
 * Reads captured bookmark timeline responses from window.__TWITTER_BOOKMARK_SPIKE__.
 * This is a manual-scroll sync path: the web app must have already loaded the
 * bookmark responses we want to archive.
 */

const TwitterAdapter = {
  canHandle(url) {
    try {
      const u = typeof url === "string" ? new URL(url) : url;
      return u.hostname === "x.com" || u.hostname === "twitter.com";
    } catch {
      return false;
    }
  },

  isBookmarksPage(url) {
    try {
      const u = typeof url === "string" ? new URL(url) : url;
      return this.canHandle(u) && u.pathname.startsWith("/i/bookmarks");
    } catch {
      return false;
    }
  },

  async exportAll(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: exportFromSpike,
      world: "MAIN",
    });

    if (!results || !results[0]) throw new Error("Script injection failed");
    return results[0].result;
  },
};

function exportFromSpike() {
  const spike = window.__TWITTER_BOOKMARK_SPIKE__;
  const diagnostics = {
    matchedUrls: spike?.matchedUrls || 0,
    transports: spike?.transports || {},
    startedAt: spike?.startedAt || null,
    cachedTweets: spike?.bookmarkOrder?.length || 0,
    path: "captured-responses",
    route: window.location.pathname,
  };

  if (!spike) {
    return {
      error: "Twitter spike script is not loaded on this page.",
      items: [],
      diagnostics,
    };
  }

  const ids = Array.isArray(spike.bookmarkOrder) ? spike.bookmarkOrder : [];
  const items = ids.map((id) => spike.tweetCache?.[id]).filter(Boolean);

  if (items.length === 0) {
    return {
      error: "No captured bookmark responses yet. Open the bookmarks page and scroll first.",
      items: [],
      diagnostics,
    };
  }

  return { items, diagnostics };
}
