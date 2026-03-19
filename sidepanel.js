/**
 * Side panel: shows archived bookmarks, reacts to live captures,
 * supports delete, search, sync, and export.
 *
 * Listens on chrome.storage.onChanged so it works regardless of
 * how bookmarks arrive (live capture, sync, another tab, etc.).
 * This pattern ports cleanly to multi-platform (X, Farcaster, …).
 */

const listEl = document.getElementById("bookmarkList");
const statsEl = document.getElementById("stats");
const searchEl = document.getElementById("search");
const toastEl = document.getElementById("toast");
const toastTextEl = document.getElementById("toast-text");

let allBookmarks = {};

// ── Init ──────────────────────────────────────────────────────

async function init() {
  await loadBookmarks();
  renderList();
  watchStorage();
}

// ── Data ──────────────────────────────────────────────────────

async function loadBookmarks() {
  const result = await chrome.runtime.sendMessage({ type: "FC_GET_ALL_BOOKMARKS" });
  allBookmarks = result?.bookmarks || {};
}

function getSortedBookmarks(filter) {
  let entries = Object.values(allBookmarks);

  if (filter) {
    const q = filter.toLowerCase();
    entries = entries.filter((b) => {
      const text = extractText(b).toLowerCase();
      const author = extractAuthor(b).toLowerCase();
      return text.includes(q) || author.includes(q);
    });
  }

  // Newest first (descending). Prefer saved_at, fall back to the cast's
  // published timestamp so synced items without a saved_at still sort properly.
  entries.sort((a, b) => {
    const ta = bestTime(a);
    const tb = bestTime(b);
    return tb - ta;
  });

  return entries;
}

function parseTime(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

function bestTime(b) {
  // Try saved_at first, then fall back to the cast's publish timestamp
  const saved = parseTime(b.saved_at);
  if (saved > 0) return saved;
  const d = b.castData;
  if (!d) return 0;
  return parseTime(d.bookmarkedAt) || parseTime(d.timestamp) ||
    parseTime(d.publishedAt) || parseTime(d.published_at) || 0;
}

// ── Rendering ─────────────────────────────────────────────────

function renderList() {
  const filter = searchEl.value.trim();
  const bookmarks = getSortedBookmarks(filter);
  const total = Object.keys(allBookmarks).length;

  statsEl.textContent = `${total} bookmark${total !== 1 ? "s" : ""} archived`;

  if (bookmarks.length === 0) {
    listEl.innerHTML = filter
      ? `<div class="empty-state"><p>No matches for "${escapeHtml(filter)}"</p></div>`
      : `<div class="empty-state">
           <p>No bookmarks yet</p>
           <p class="hint">Bookmark a cast on Farcaster and it will appear here automatically.</p>
         </div>`;
    return;
  }

  listEl.innerHTML = bookmarks.map((b) => {
    const author = extractAuthor(b);
    const fid = extractFid(b);
    const text = extractText(b);
    const time = formatTime(b.saved_at);
    const via = b.captured_via || "unknown";
    const hash = b.castHash || "";
    const castUrl = extractCastUrl(b);

    return `
      <div class="bookmark-item" data-hash="${escapeAttr(hash)}">
        <div class="bookmark-content" data-url="${escapeAttr(castUrl || "")}">
          <div class="bookmark-author">
            ${escapeHtml(author)}${fid ? `<span class="fid">#${fid}</span>` : ""}
          </div>
          <div class="bookmark-text">${escapeHtml(text || "(no text)")}</div>
        </div>
        <div class="bookmark-footer">
          <span>${time}</span>
          <span>
            <span class="capture-badge">${via}</span>
            <button class="delete-btn" data-hash="${escapeAttr(hash)}" title="Remove">&times;</button>
          </span>
        </div>
      </div>`;
  }).join("");

  // Click content → open cast
  listEl.querySelectorAll(".bookmark-content").forEach((el) => {
    el.addEventListener("click", () => {
      const url = el.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });

  // Click × → delete
  listEl.querySelectorAll(".delete-btn").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const hash = el.dataset.hash;
      if (!hash) return;
      delete allBookmarks[hash];
      renderList();
      await chrome.runtime.sendMessage({ type: "FC_DELETE_BOOKMARK", castHash: hash });
    });
  });
}

// ── Extract helpers ───────────────────────────────────────────

function extractText(b) {
  const d = b.castData;
  if (!d) return "";
  return d.text || d.body?.text || d.cast?.text || d.result?.cast?.text || "";
}

function extractAuthor(b) {
  const d = b.castData;
  if (!d) return "Unknown";
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  return a.displayName || a.display_name || a.username ||
    (a.fid ? `fid:${a.fid}` : "Unknown");
}

function extractFid(b) {
  const d = b.castData;
  if (!d) return null;
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  return a.fid || d.authorFid || null;
}

function extractCastUrl(b) {
  const d = b.castData;
  if (!d) return null;
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  const username = a.username;
  const hash = b.castHash || d.hash || d.cast?.hash;
  if (username && hash) {
    return `https://farcaster.xyz/${username}/${hash.slice(0, 10)}`;
  }
  return null;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ── Toast ─────────────────────────────────────────────────────

let toastTimer = null;

function showToast(bookmark, { removed = false } = {}) {
  const author = extractAuthor(bookmark);
  const text = extractText(bookmark);
  const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;

  const labelEl = toastEl.querySelector(".toast-label");
  if (removed) {
    labelEl.textContent = "Bookmark removed";
    toastTextEl.textContent = `${author}: ${preview || "Removed from archive"}`;
    toastEl.classList.add("removed");
  } else {
    labelEl.textContent = "Bookmark captured";
    toastTextEl.textContent = `${author}: ${preview || "New bookmark saved"}`;
    toastEl.classList.remove("removed");
  }

  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    toastEl.classList.remove("removed");
  }, 4000);
}

// ── Live updates via storage.onChanged ────────────────────────

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    // If bookmarks changed, reload the full set
    if (changes.fc_bookmarks) {
      allBookmarks = changes.fc_bookmarks.newValue || {};
      renderList();
    }

    // If a new bookmark was just captured, show toast
    if (changes.fc_last_added && changes.fc_last_added.newValue) {
      const added = changes.fc_last_added.newValue;
      showToast(added);

      // Scroll to top and highlight
      listEl.scrollTop = 0;
      requestAnimationFrame(() => {
        const el = listEl.querySelector(`[data-hash="${CSS.escape(added.castHash)}"]`);
        if (el) el.classList.add("fresh");
      });
    }

    // If a bookmark was removed (unbookmarked on Farcaster), show removal toast
    if (changes.fc_last_removed && changes.fc_last_removed.newValue) {
      const removed = changes.fc_last_removed.newValue;
      showToast(removed, { removed: true });
    }
  });
}

// ── Search ────────────────────────────────────────────────────

searchEl.addEventListener("input", () => renderList());

// ── Sync ──────────────────────────────────────────────────────

document.getElementById("syncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("syncBtn");
  btn.disabled = true;
  btn.textContent = "Syncing...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url?.includes("farcaster.xyz")) {
      flash(btn, "Open Farcaster first");
      return;
    }

    const result = await FarcasterAdapter.exportAll(tab.id);

    if (result.error) {
      flash(btn, "Sync failed");
      return;
    }

    if (result.items.length > 0) {
      const syncResult = await chrome.runtime.sendMessage({
        type: "FC_SYNC_BOOKMARKS",
        items: result.items,
      });
      // storage.onChanged will trigger renderList
      flash(btn, `Synced ${syncResult.added} new`);
    } else {
      flash(btn, "No bookmarks found");
    }
  } catch (e) {
    flash(btn, "Error");
  }
});

// ── Export ─────────────────────────────────────────────────────

document.getElementById("exportBtn").addEventListener("click", () => {
  const entries = getSortedBookmarks();
  if (entries.length === 0) return;
  const items = entries.map((b) => b.castData).filter(Boolean);
  const payload = buildExportPayload(items, { source: "archive" });
  downloadJSON(payload);
});

document.getElementById("obsidianBtn").addEventListener("click", () => {
  if (Object.keys(allBookmarks).length === 0) return;
  exportToObsidian(allBookmarks);
});

// ── Util ──────────────────────────────────────────────────────

function flash(btn, msg) {
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = "Sync All"; btn.disabled = false; }, 2000);
}

// ── Start ─────────────────────────────────────────────────────

init();
