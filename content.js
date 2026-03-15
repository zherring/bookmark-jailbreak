/**
 * Content script running in ISOLATED world on farcaster.xyz.
 * Relays bookmark action messages from the MAIN world intercept
 * to the background service worker via chrome.runtime.sendMessage.
 */
(function () {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "FC_BOOKMARK_ACTION") return;

    chrome.runtime.sendMessage({
      type: "FC_BOOKMARK_ACTION",
      action: event.data.action,
      castHash: event.data.castHash,
      castData: event.data.castData,
      url: event.data.url,
      timestamp: event.data.timestamp,
    });
  });
})();
