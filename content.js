/**
 * Content script — ISOLATED world on farcaster.xyz.
 *
 * PRIMARY bookmark detection layer: observes the DOM for bookmark
 * menu item clicks. Much more resilient than fetch interception.
 *
 * Detection flow:
 *   1. Click delegation catches menuitem clicks with "Bookmark"/"Unbookmark" text
 *   2. Find the Radix trigger (data-state="open") — it's inside the cast card
 *   3. Traverse up from trigger to find cast URL link → extract hash
 *   4. Ask MAIN world for cached cast data (optional enrichment)
 *   5. Send FC_BOOKMARK_ACTION to background
 *
 * Also relays FC_BOOKMARK_ACTION from MAIN world fetch intercept (backup layer).
 */
(function () {
  const DEBUG = true; // TEMP: on for debugging
  function log(...args) {
    if (DEBUG) console.log("[FC-BM:content]", ...args);
  }

  // ── Extension context safety ────────────────────────────────
  // After extension reload, the old content script's chrome.runtime
  // is dead. Wrap all runtime calls so they fail gracefully.

  let contextValid = true;

  function safeSendMessage(msg) {
    if (!contextValid) {
      log("Context invalidated — message dropped. Refresh page.");
      return;
    }
    try {
      chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (err.message?.includes("Extension context invalidated")) {
        contextValid = false;
        log("Extension context invalidated — content script is stale. Refresh the page to reconnect.");
        showStaleWarning();
      } else {
        log("sendMessage error:", err.message);
      }
    }
  }

  function showStaleWarning() {
    // Small non-intrusive banner so user knows to refresh
    const banner = document.createElement("div");
    banner.textContent = "🔌 FC Bookmarks extension reloaded — refresh this tab to reconnect";
    banner.style.cssText = `
      position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
      background: #f59e0b; color: #000; padding: 8px 16px; border-radius: 8px;
      font: 13px/1.4 system-ui, sans-serif; z-index: 999999; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;
    banner.addEventListener("click", () => {
      banner.remove();
      window.location.reload();
    });
    document.body.appendChild(banner);
    // Auto-dismiss after 8s
    setTimeout(() => banner.remove(), 8000);
  }

  // ── Track which cast the context menu was opened for ────────

  let lastTriggerCastHash = null;
  let lastTriggerCastUrl = null;

  // When ANY button/trigger is clicked, check if it's inside a cast card
  // and store the cast hash. This catches the "..." menu trigger before
  // the Radix portal renders the menu elsewhere in the DOM.
  document.addEventListener("click", (e) => {
    // Look for cast hash near the click target
    const hash = findCastHashNear(e.target);
    if (hash) {
      lastTriggerCastHash = hash;
      log("Trigger click captured cast hash:", hash);
    } else {
      // Log what we clicked for debugging
      const tag = e.target.tagName;
      const cls = e.target.className?.toString().slice(0, 80);
      const txt = e.target.textContent?.slice(0, 40);
      log("Click (no hash found):", tag, cls, txt);
    }
  }, true); // capture phase — fires before Radix processes the click

  // ── Primary detection: bookmark menu item clicks ───────────

  document.addEventListener("click", (e) => {
    const menuItem = e.target.closest("[role='menuitem']");
    if (!menuItem) return;

    const text = menuItem.textContent.trim().toLowerCase();
    if (text !== "bookmark" && text !== "unbookmark") return;

    const isRemove = text === "unbookmark";
    log("Bookmark menu click detected:", isRemove ? "REMOVE" : "ADD");

    // Strategy 1: Use the hash we captured from the trigger click
    let castHash = lastTriggerCastHash;
    log("Strategy 1 (trigger click):", castHash);

    // Strategy 2: Find the Radix trigger with data-state="open"
    if (!castHash) {
      castHash = findHashFromOpenTrigger();
      log("Strategy 2 (open trigger):", castHash);
    }

    // Strategy 3: Check the current page URL (if on a cast page)
    if (!castHash) {
      castHash = extractHashFromPageUrl();
      log("Strategy 3 (page URL):", castHash);
    }

    // Strategy 4: Dump all links on page for debugging
    if (!castHash) {
      const allTriggers = document.querySelectorAll('[data-state="open"], [aria-expanded="true"]');
      log("Open triggers found:", allTriggers.length);
      allTriggers.forEach((t, i) => {
        log(`  trigger ${i}:`, t.tagName, t.className?.slice(0, 60), t.outerHTML?.slice(0, 200));
        const nearbyLinks = [];
        let el = t;
        for (let j = 0; j < 15 && el; j++) {
          el.querySelectorAll?.("a[href]")?.forEach(a => nearbyLinks.push(a.getAttribute("href")));
          el = el.parentElement;
        }
        log(`  nearby links:`, nearbyLinks);
      });
      log("WARNING: bookmark click detected but no cast hash found");
      return;
    }

    log("Resolved cast hash:", castHash, isRemove ? "(remove)" : "(add)");

    // Ask MAIN world for cached cast data, then send to background
    requestCastData(castHash, (castData) => {
      safeSendMessage({
        type: "FC_BOOKMARK_ACTION",
        action: isRemove ? "remove" : "add",
        castHash,
        castData: isRemove ? null : (castData || { hash: castHash }),
        url: window.location.href,
        timestamp: new Date().toISOString(),
      });
      log("Sent FC_BOOKMARK_ACTION:", isRemove ? "remove" : "add", castHash);
    });
  });

  // ── MutationObserver: catch menu items added to DOM ─────────
  // Radix portals insert menu items dynamically. Watch for them
  // and attach a safety click listener (belt + suspenders).

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const items = node.querySelectorAll
          ? node.querySelectorAll("[role='menuitem']")
          : [];
        for (const item of items) {
          const text = item.textContent.trim().toLowerCase();
          if (text === "bookmark" || text === "unbookmark") {
            log("Bookmark menuitem appeared in DOM:", text);
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ── Hash extraction strategies ─────────────────────────────

  function findCastHashNear(element) {
    // Walk up from element looking for a cast container with a link
    let el = element;
    for (let i = 0; i < 20 && el; i++) {
      // Look for links with cast URL pattern: /username/0xhash
      const links = el.querySelectorAll ? el.querySelectorAll("a[href]") : [];
      for (const link of links) {
        const hash = extractCastHashFromHref(link.getAttribute("href"));
        if (hash) return hash;
      }
      // Check the element itself
      if (el.tagName === "A" && el.href) {
        const hash = extractCastHashFromHref(el.getAttribute("href"));
        if (hash) return hash;
      }
      // Check data attributes
      if (el.dataset) {
        for (const [key, val] of Object.entries(el.dataset)) {
          if (typeof val === "string" && val.match(/^0x[a-fA-F0-9]{8,}$/)) {
            return val;
          }
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function findHashFromOpenTrigger() {
    // Find Radix triggers in open state — the menu trigger inside the cast card
    const triggers = document.querySelectorAll(
      '[data-state="open"], [aria-expanded="true"]'
    );
    for (const trigger of triggers) {
      const hash = findCastHashNear(trigger);
      if (hash) {
        log("Found hash from open trigger:", hash);
        return hash;
      }
    }
    return null;
  }

  function extractCastHashFromHref(href) {
    if (!href) return null;
    // Match patterns like /username/0xabc123 or /~/cast/0xabc123
    const match = href.match(/\/(?:0x[a-fA-F0-9]{8,})/);
    if (match) {
      return match[0].slice(1); // remove leading /
    }
    return null;
  }

  function extractHashFromPageUrl() {
    const match = window.location.pathname.match(/\/(0x[a-fA-F0-9]{8,})/);
    return match ? match[1] : null;
  }

  // ── MAIN world cast data lookup ────────────────────────────

  function requestCastData(castHash, callback) {
    const nonce = "fc_cast_" + Date.now() + "_" + Math.random().toString(36).slice(2);

    function onReply(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== nonce) return;
      window.removeEventListener("message", onReply);
      callback(event.data.castData || null);
    }

    window.addEventListener("message", onReply);
    window.postMessage({ type: "FC_CAST_LOOKUP", nonce, castHash }, "*");

    // Timeout — don't wait forever for cast data, send without it
    setTimeout(() => {
      window.removeEventListener("message", onReply);
      callback(null);
    }, 300);
  }

  // ── Relay: MAIN world postMessage → background (backup) ────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "FC_BOOKMARK_ACTION") return;

    safeSendMessage({
      type: "FC_BOOKMARK_ACTION",
      action: event.data.action,
      castHash: event.data.castHash,
      castData: event.data.castData,
      url: event.data.url,
      timestamp: event.data.timestamp,
    });
  });

  // ── Handle backup queries from background (webRequest layer) ──

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "FC_WEBREQUEST_BACKUP") {
        const hash = lastTriggerCastHash || findHashFromOpenTrigger() || extractHashFromPageUrl();
        if (hash) {
          safeSendMessage({
            type: "FC_BOOKMARK_ACTION",
            action: message.isRemove ? "remove" : "add",
            castHash: hash,
            castData: null,
            url: window.location.href,
            timestamp: message.timestamp,
          });
        }
        sendResponse({ ok: true, found: !!hash });
      }
    });
  } catch (err) {
    log("Could not register onMessage listener:", err.message);
    contextValid = false;
  }

  log("Content script loaded — DOM bookmark detection active");
})();
