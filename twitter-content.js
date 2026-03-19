/**
 * Twitter/X content bridge.
 *
 * Relays bookmark mutation events from the MAIN world probe to the
 * extension background worker.
 */
(function () {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || (data.type !== "FC_TWITTER_BOOKMARK_ACTION" && data.type !== "FC_TWITTER_BOOKMARK_ENRICH")) return;

    try {
      chrome.runtime.sendMessage({
        type: data.type,
        action: data.action,
        itemId: data.itemId,
        rawData: data.rawData || null,
        url: data.url || window.location.href,
        timestamp: data.timestamp || new Date().toISOString(),
      });
    } catch (error) {
      // Extension context can be stale after reload. Ignore until the page refreshes.
    }
  });
})();
