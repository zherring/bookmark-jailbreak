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
const sortEl = document.getElementById("sortMode");
const toastEl = document.getElementById("toast");
const toastTextEl = document.getElementById("toast-text");

let allBookmarks = {};

// ── Init ──────────────────────────────────────────────────────

async function init() {
  sortEl.value = getSortMode();
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
      const text = extractBookmarkText(b).toLowerCase();
      const author = extractBookmarkAuthor(b).toLowerCase();
      const quoted = extractBookmarkQuote(b);
      const quotedText = quoted?.text?.toLowerCase() || "";
      const quotedAuthor = quoted?.author_display_name?.toLowerCase() || "";
      return text.includes(q) || author.includes(q) || quotedText.includes(q) || quotedAuthor.includes(q);
    });
  }

  // Newest first (descending). Prefer saved_at, fall back to the cast's
  // published timestamp so synced items without a saved_at still sort properly.
  entries.sort((a, b) => {
    const ta = bestTime(a, getSortMode());
    const tb = bestTime(b, getSortMode());
    return tb - ta;
  });

  return entries;
}

function parseTime(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

function bestTime(b, sortMode) {
  const saved = parseTime(b.saved_at);
  const published = parseTime(b.published_at) || parseTime(extractBookmarkPublishedAt(b));

  if (sortMode === "published") {
    return published || saved || 0;
  }
  return saved || published || 0;
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
           <p class="hint">Sync or capture bookmarks from Farcaster or Twitter/X and they will appear here.</p>
         </div>`;
    return;
  }

  listEl.innerHTML = bookmarks.map((b) => {
    const author = extractBookmarkAuthor(b);
    const authorMeta = extractBookmarkAuthorMeta(b);
    const text = extractBookmarkText(b);
    const time = formatBookmarkTime(b);
    const via = b.captured_via || "unknown";
    const platform = getBookmarkPlatform(b);
    const bookmarkId = getBookmarkId(b) || "";
    const recordUrl = extractBookmarkUrl(b);
    const quoted = extractBookmarkQuote(b);

    return `
      <div class="bookmark-item platform-${escapeAttr(platform)}" data-id="${escapeAttr(bookmarkId)}">
        <div class="bookmark-content" data-url="${escapeAttr(recordUrl || "")}">
          <div class="bookmark-author">
            ${escapeHtml(author)}${authorMeta ? `<span class="fid">${escapeHtml(authorMeta)}</span>` : ""}
          </div>
          <div class="bookmark-text">${escapeHtml(text || "(no text)")}</div>
          ${renderQuotedItem(quoted)}
        </div>
        <div class="bookmark-footer">
          <span>${time}</span>
          <span>
            <span class="capture-badge platform-${escapeAttr(platform)}">${platform} · ${via}</span>
            <button class="delete-btn" data-id="${escapeAttr(bookmarkId)}" title="Remove">&times;</button>
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
      const bookmarkId = el.dataset.id;
      if (!bookmarkId) return;
      removeLocalBookmark(bookmarkId);
      renderList();
      await chrome.runtime.sendMessage({ type: "FC_DELETE_BOOKMARK", castHash: bookmarkId });
    });
  });
}

function removeLocalBookmark(bookmarkId) {
  delete allBookmarks[bookmarkId];
  if (bookmarkId.startsWith("farcaster:")) {
    delete allBookmarks[bookmarkId.slice("farcaster:".length)];
  }
}

function getSortMode() {
  return localStorage.getItem("fc_sort_mode") || "saved";
}

function formatBookmarkTime(bookmark) {
  const sortMode = getSortMode();
  const publishedAt = extractBookmarkPublishedAt(bookmark);

  if (sortMode === "published" && publishedAt) {
    return `posted ${formatTime(publishedAt)}`;
  }
  if (bookmark.saved_at) {
    return `saved ${formatTime(bookmark.saved_at)}`;
  }
  if (publishedAt) {
    return `posted ${formatTime(publishedAt)}`;
  }
  return "";
}

function renderQuotedItem(quoted) {
  if (!quoted) return "";
  const author = quoted.author_display_name || "Unknown";
  const handle = quoted.author_username ? `@${quoted.author_username}` : quoted.platform;
  const text = quoted.text || "(no text)";
  return `
    <div class="bookmark-quote">
      <div class="bookmark-quote-author">${escapeHtml(author)} <span class="fid">${escapeHtml(handle)}</span></div>
      <div class="bookmark-quote-text">${escapeHtml(text)}</div>
    </div>`;
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
  const author = extractBookmarkAuthor(bookmark);
  const text = extractBookmarkText(bookmark);
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
        const bookmarkId = getBookmarkId(added);
        const el = bookmarkId ? listEl.querySelector(`[data-id="${CSS.escape(bookmarkId)}"]`) : null;
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
sortEl.addEventListener("change", () => {
  localStorage.setItem("fc_sort_mode", sortEl.value);
  renderList();
});

// ── Sync ──────────────────────────────────────────────────────

document.getElementById("syncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("syncBtn");
  btn.disabled = true;
  btn.textContent = "Syncing...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      flash(btn, "No active tab");
      return;
    }

    let adapter = null;
    if (FarcasterAdapter.canHandle(tab.url)) adapter = FarcasterAdapter;
    if (TwitterAdapter.canHandle(tab.url)) adapter = TwitterAdapter;
    if (!adapter) {
      flash(btn, "Open Farcaster or X");
      return;
    }

    const result = await adapter.exportAll(tab.id);

    if (result.error) {
      flash(btn, "Sync failed");
      return;
    }

    if (result.items.length > 0) {
      const syncResult = await chrome.runtime.sendMessage({
        type: "FC_SYNC_BOOKMARKS",
        platform: adapter === TwitterAdapter ? "twitter" : "farcaster",
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
  const payload = buildExportPayload(entries, { path: "archive" });
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
