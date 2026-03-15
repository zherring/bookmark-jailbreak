/**
 * Drawer overlay for Farcaster Bookmarks Exporter.
 * Runs in ISOLATED world on farcaster.xyz pages.
 *
 * Creates a right-side drawer showing stored bookmarks with
 * juicy animations when new bookmarks are captured.
 */
(function () {
  "use strict";

  // Prevent double-init (e.g. if script is re-injected)
  if (window.__FC_DRAWER_INIT__) return;
  window.__FC_DRAWER_INIT__ = true;

  // ── State ──────────────────────────────────────────────
  let isOpen = false;
  let bookmarks = {}; // keyed by castHash
  let sortedList = []; // sorted array for display

  // ── Inject CSS ─────────────────────────────────────────
  function injectStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("drawer.css");
    (document.head || document.documentElement).appendChild(link);
  }

  // ── Build DOM ──────────────────────────────────────────
  let tab, panel, backdrop, listEl, badgeEl, headerCountEl;

  function buildDrawer() {
    // Tab handle
    tab = document.createElement("div");
    tab.className = "fc-drawer-tab";
    tab.title = "Farcaster Bookmarks";
    tab.innerHTML = `
      <svg class="fc-drawer-tab-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z"/>
      </svg>
      <span class="fc-drawer-tab-badge">0</span>
    `;
    tab.addEventListener("click", toggleDrawer);
    badgeEl = tab.querySelector(".fc-drawer-tab-badge");

    // Backdrop
    backdrop = document.createElement("div");
    backdrop.className = "fc-drawer-backdrop";
    backdrop.addEventListener("click", closeDrawer);

    // Panel
    panel = document.createElement("div");
    panel.className = "fc-drawer-panel";
    panel.innerHTML = `
      <div class="fc-drawer-header">
        <div class="fc-drawer-header-left">
          <span class="fc-drawer-header-title">Bookmarks</span>
          <span class="fc-drawer-header-count">0</span>
        </div>
        <div class="fc-drawer-header-actions">
          <button class="fc-drawer-export-btn">Export</button>
          <button class="fc-drawer-close">&times;</button>
        </div>
      </div>
      <div class="fc-drawer-list"></div>
    `;

    headerCountEl = panel.querySelector(".fc-drawer-header-count");
    listEl = panel.querySelector(".fc-drawer-list");

    panel.querySelector(".fc-drawer-close").addEventListener("click", closeDrawer);
    panel.querySelector(".fc-drawer-export-btn").addEventListener("click", handleExport);

    // Prevent host page scroll when scrolling inside drawer
    panel.addEventListener("wheel", (e) => {
      const atTop = listEl.scrollTop === 0 && e.deltaY < 0;
      const atBottom =
        listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight && e.deltaY > 0;
      if (atTop || atBottom) {
        e.preventDefault();
      }
    }, { passive: false });

    // Append to page
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(tab);
  }

  // ── Toggle / Open / Close ──────────────────────────────
  function toggleDrawer() {
    if (isOpen) closeDrawer();
    else openDrawer();
  }

  function openDrawer() {
    isOpen = true;
    panel.classList.add("fc-drawer-open");
    backdrop.classList.add("fc-drawer-backdrop-visible");
    tab.style.right = "360px";
    refreshList();
  }

  function closeDrawer() {
    isOpen = false;
    panel.classList.remove("fc-drawer-open");
    backdrop.classList.remove("fc-drawer-backdrop-visible");
    tab.style.right = "0";
  }

  // ── Render bookmark list ───────────────────────────────
  function refreshList(newHash) {
    sortedList = Object.values(bookmarks).sort(
      (a, b) => new Date(b.saved_at || 0) - new Date(a.saved_at || 0)
    );

    const count = sortedList.length;
    badgeEl.textContent = count;
    headerCountEl.textContent = count;

    if (count === 0) {
      listEl.innerHTML = `
        <div class="fc-drawer-empty">
          <div class="fc-drawer-empty-icon">&#128278;</div>
          <div class="fc-drawer-empty-text">No bookmarks yet</div>
          <div class="fc-drawer-empty-sub">Bookmark a cast on Farcaster to see it here</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    for (const bm of sortedList) {
      const el = createBookmarkItem(bm);
      if (newHash && bm.castHash === newHash) {
        el.classList.add("fc-drawer-item-new");
        el.addEventListener("animationend", () => {
          el.classList.remove("fc-drawer-item-new");
        }, { once: true });
      }
      listEl.appendChild(el);
    }
  }

  function createBookmarkItem(bm) {
    const el = document.createElement("div");
    el.className = "fc-drawer-item";

    const castData = bm.castData || {};
    const author = castData.author || castData.user || {};
    const username = author.username || castData.authorUsername || "unknown";
    const displayName = author.displayName || author.display_name || "";
    const text = castData.text || castData.body?.text || "";
    const truncated = text.length > 100 ? text.slice(0, 100) + "..." : text;
    const time = formatTime(bm.saved_at);

    const authorLabel = displayName ? `${displayName} (@${username})` : `@${username}`;

    el.innerHTML = `
      <div class="fc-drawer-item-author">${escapeHtml(authorLabel)}</div>
      <div class="fc-drawer-item-text">${escapeHtml(truncated)}</div>
      <div class="fc-drawer-item-time">${escapeHtml(time)}</div>
    `;

    // Click to open cast in new tab
    const hash = bm.castHash;
    if (hash && username !== "unknown") {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        window.open(
          `https://farcaster.xyz/${username}/${hash.slice(0, 10)}`,
          "_blank"
        );
      });
    }

    return el;
  }

  // ── Juicy animations ───────────────────────────────────
  function playNewBookmarkAnimation(castHash) {
    // 1. Pulse the tab handle
    tab.classList.remove("fc-drawer-pulse");
    // Force reflow to restart animation
    void tab.offsetWidth;
    tab.classList.add("fc-drawer-pulse");
    tab.addEventListener("animationend", () => {
      tab.classList.remove("fc-drawer-pulse");
    }, { once: true });

    // 2. Flying +1 counter
    const rect = tab.getBoundingClientRect();
    const fly = document.createElement("div");
    fly.className = "fc-drawer-fly-counter";
    fly.textContent = "+1";
    fly.style.right = (window.innerWidth - rect.left + 4) + "px";
    fly.style.top = (rect.top + rect.height / 2 - 10) + "px";
    document.body.appendChild(fly);
    fly.addEventListener("animationend", () => fly.remove(), { once: true });

    // 3. If drawer is open, refresh with highlight
    if (isOpen) {
      refreshList(castHash);
    }
  }

  // ── Fetch stored bookmarks ─────────────────────────────
  function loadBookmarks() {
    chrome.runtime.sendMessage({ type: "FC_GET_ALL_BOOKMARKS" }, (response) => {
      if (chrome.runtime.lastError) return;
      const data = response?.bookmarks || {};
      bookmarks = data;
      const count = Object.keys(bookmarks).length;
      badgeEl.textContent = count;
      headerCountEl.textContent = count;
      if (isOpen) refreshList();
    });
  }

  // ── Export handler ─────────────────────────────────────
  function handleExport() {
    const items = Object.values(bookmarks)
      .map((b) => b.castData)
      .filter(Boolean);

    if (items.length === 0) return;

    const payload = {
      source: "farcaster",
      exported_at: new Date().toISOString(),
      meta: {
        route: "https://farcaster.xyz/~/bookmarks",
        extractor: "farcaster-bookmarks-exporter",
        version: "0.2.0",
        path: "drawer",
      },
      items: items,
    };

    const date = new Date().toISOString().slice(0, 10);
    const filename = `farcaster-bookmarks-${date}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Handle new bookmark events from content.js ─────────
  function onBookmarkAction(data) {
    const { action, castHash, castData, timestamp } = data;
    if (!castHash) return;

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

    const count = Object.keys(bookmarks).length;
    badgeEl.textContent = count;
    headerCountEl.textContent = count;

    if (action !== "remove") {
      playNewBookmarkAnimation(castHash);
    } else if (isOpen) {
      refreshList();
    }
  }

  // ── Helpers ────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return "just now";
      if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
      if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
      if (diff < 604800000) return Math.floor(diff / 86400000) + "d ago";
      return d.toLocaleDateString();
    } catch {
      return iso;
    }
  }

  // ── Initialize ─────────────────────────────────────────
  function init() {
    injectStyles();

    // Wait for body to be available
    if (document.body) {
      buildDrawer();
      loadBookmarks();
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        buildDrawer();
        loadBookmarks();
      });
    }
  }

  // Expose the action handler for content.js to call
  window.__FC_DRAWER_ON_ACTION__ = onBookmarkAction;

  init();
})();
