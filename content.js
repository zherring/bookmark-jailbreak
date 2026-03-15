/**
 * Content script running in ISOLATED world on farcaster.xyz.
 * Relays bookmark action messages from the MAIN world intercept
 * to the background service worker via chrome.runtime.sendMessage,
 * and notifies the drawer overlay for animations.
 */
(function () {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "FC_BOOKMARK_ACTION") return;

    const payload = {
      type: "FC_BOOKMARK_ACTION",
      action: event.data.action,
      castHash: event.data.castHash,
      castData: event.data.castData,
      url: event.data.url,
      timestamp: event.data.timestamp,
    };

    // Forward to background service worker
    chrome.runtime.sendMessage(payload);

    // Notify drawer for animation
    if (typeof window.__FC_DRAWER_ON_ACTION__ === "function") {
      window.__FC_DRAWER_ON_ACTION__(payload);
    }
  });
})();
