/**
 * Side panel: shows archived bookmarks, reacts to live captures,
 * supports delete, search, sync, and export.
 *
 * Listens on chrome.storage.onChanged so it works regardless of
 * how bookmarks arrive (live capture, sync, another tab, etc.).
 * This pattern ports cleanly to multi-platform (X, Farcaster, …).
 */

const listEl = document.getElementById("bookmarkList");
const feedEl = document.getElementById("feedView");
const pillEl = document.getElementById("pill");
const searchEl = document.getElementById("search");
const sortToggleEl = document.getElementById("sortToggle");
const toastEl = document.getElementById("toast");
const toastLabelEl = document.getElementById("toast-label");
const toastTextEl = document.getElementById("toast-text");
const viewListBtn = document.getElementById("viewList");
const viewFeedBtn = document.getElementById("viewFeed");
const searchBarEl = document.querySelector(".search-bar");
const actionsBarEl = document.querySelector(".actions");

let allBookmarks = {};
let currentView = "list"; // "list" or "feed"
let platformFilter = "all"; // "all", "farcaster", "twitter"
const platformToggleEl = document.getElementById("platformToggle");

// ── Theme (domain-keyed accent color) ───────────────────────

const THEMES = {
  farcaster: { accent: "#7c3aed", accentLight: "#ede9fe", accentHover: "#6d28d9" },
  twitter:   { accent: "#111827", accentLight: "#e5e7eb", accentHover: "#1f2937" },
  default:   { accent: "#7c3aed", accentLight: "#ede9fe", accentHover: "#6d28d9" },
};

async function applyTheme() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    let theme = THEMES.default;
    if (/x\.com|twitter\.com/.test(url)) theme = THEMES.twitter;
    else if (/farcaster\.xyz/.test(url)) theme = THEMES.farcaster;
    document.documentElement.style.setProperty("--accent", theme.accent);
    document.documentElement.style.setProperty("--accent-light", theme.accentLight);
    document.documentElement.style.setProperty("--accent-hover", theme.accentHover);
  } catch {
    // ignore — keep default purple
  }
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
  updateSortToggle();
  applyTheme();
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

  if (platformFilter !== "all") {
    entries = entries.filter((b) => getBookmarkPlatform(b) === platformFilter);
  }

  if (filter) {
    const parsed = parseSearchFilter(filter);
    entries = entries.filter((b) => {
      // from: operator — match author display name or username
      if (parsed.from) {
        const author = extractBookmarkAuthor(b).toLowerCase();
        const username = (extractBookmarkAuthorUsername(b) || "").toLowerCase();
        if (!author.includes(parsed.from) && !username.includes(parsed.from)) return false;
      }
      // topic: operator — match detected topics
      if (parsed.topic) {
        const text = extractBookmarkText(b);
        const topics = detectExportTopics(text).map((k) => (EXPORT_TOPICS[k]?.label || k).toLowerCase());
        if (!topics.some((t) => t.includes(parsed.topic))) return false;
      }
      // free text — search everything
      if (parsed.text) {
        const q = parsed.text;
        const text = extractBookmarkText(b).toLowerCase();
        const author = extractBookmarkAuthor(b).toLowerCase();
        const quoted = extractBookmarkQuote(b);
        const quotedText = quoted?.text?.toLowerCase() || "";
        const quotedAuthor = quoted?.author_display_name?.toLowerCase() || "";
        if (!text.includes(q) && !author.includes(q) && !quotedText.includes(q) && !quotedAuthor.includes(q)) return false;
      }
      return true;
    });
  }

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

  pillEl.textContent = total;

  if (bookmarks.length === 0) {
    listEl.innerHTML = filter
      ? `<div class="empty-state"><p>No matches for "${escapeHtml(filter)}"</p></div>`
      : `<div class="empty-state">
           <p>No bookmarks yet</p>
           <p class="hint">Go to your bookmarks tab to sync them all, or bookmark individual posts.</p>
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

function updateSortToggle() {
  const mode = getSortMode();
  sortToggleEl.textContent = mode === "published" ? "Posted" : "Saved";
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

  if (removed) {
    toastLabelEl.textContent = "Bookmark removed";
    toastTextEl.innerHTML = escapeHtml(`${author}: ${preview || "Removed from archive"}`);
    toastEl.className = "toast removed show";
  } else {
    toastLabelEl.textContent = "Bookmark captured";
    toastTextEl.innerHTML = escapeHtml(`${author}: ${preview || "New bookmark saved"}`);
    toastEl.className = "toast show";
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 4000);
}

function showNavigateToast(destUrl, label) {
  toastLabelEl.textContent = "Navigate to bookmarks";
  toastTextEl.innerHTML = `Open <a id="toast-nav-link" href="#">${escapeHtml(label)}</a> to sync your bookmarks`;
  toastEl.className = "toast navigate show";

  // Make the link clickable
  const link = document.getElementById("toast-nav-link");
  if (link) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id) chrome.tabs.update(tab.id, { url: destUrl });
      });
      toastEl.className = "toast";
    });
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 8000);
}

// ── Live updates via storage.onChanged ────────────────────────

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.fc_bookmarks) {
      allBookmarks = changes.fc_bookmarks.newValue || {};
      renderList();
      if (currentView === "feed") renderFeed();
    }

    if (changes.fc_last_added && changes.fc_last_added.newValue) {
      const added = changes.fc_last_added.newValue;
      showToast(added);

      listEl.scrollTop = 0;
      requestAnimationFrame(() => {
        const bookmarkId = getBookmarkId(added);
        const el = bookmarkId ? listEl.querySelector(`[data-id="${CSS.escape(bookmarkId)}"]`) : null;
        if (el) el.classList.add("fresh");
      });
    }

    if (changes.fc_last_removed && changes.fc_last_removed.newValue) {
      const removed = changes.fc_last_removed.newValue;
      showToast(removed, { removed: true });
    }
  });
}

// ── Search & Sort ─────────────────────────────────────────────

function parseSearchFilter(raw) {
  let from = null;
  let topic = null;
  let rest = raw;

  // Extract from:value
  rest = rest.replace(/\bfrom:(\S+)/gi, (_, v) => { from = v.toLowerCase(); return ""; });
  // Extract topic:value (allow spaces via quotes: topic:"some topic")
  rest = rest.replace(/\btopic:"([^"]+)"/gi, (_, v) => { topic = v.toLowerCase(); return ""; });
  rest = rest.replace(/\btopic:(\S+)/gi, (_, v) => { topic = v.toLowerCase(); return ""; });

  const text = rest.trim().toLowerCase() || null;
  return { from, topic, text };
}

function searchFor(query) {
  searchEl.value = query;
  setView("list");
  renderList();
}

searchEl.addEventListener("input", () => renderList());

sortToggleEl.addEventListener("click", () => {
  const current = getSortMode();
  const next = current === "saved" ? "published" : "saved";
  localStorage.setItem("fc_sort_mode", next);
  updateSortToggle();
  renderList();
});

platformToggleEl.addEventListener("click", () => {
  const cycle = { all: "farcaster", farcaster: "twitter", twitter: "all" };
  platformFilter = cycle[platformFilter] || "all";
  const labels = { all: "All", farcaster: "Farcaster", twitter: "Twitter" };
  platformToggleEl.textContent = labels[platformFilter];
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
      // Not on FC or X at all — show toast with both options
      showNavigateToast("https://farcaster.xyz/~/bookmarks", "farcaster.xyz/~/bookmarks");
      flash(btn, "Sync All");
      return;
    }

    // On FC or X but not on the bookmarks page
    const onBookmarksPage = adapter === FarcasterAdapter
      ? FarcasterAdapter.isBookmarksPage(tab.url)
      : TwitterAdapter.isBookmarksPage(tab.url);
    if (!onBookmarksPage) {
      const isFc = adapter === FarcasterAdapter;
      const destUrl = isFc ? "https://farcaster.xyz/~/bookmarks" : "https://x.com/i/bookmarks";
      const label = isFc ? "farcaster.xyz/~/bookmarks" : "x.com/i/bookmarks";
      showNavigateToast(destUrl, label);
      flash(btn, "Sync All");
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

document.getElementById("mdBtn").addEventListener("click", () => {
  const entries = getSortedBookmarks();
  if (entries.length === 0) return;
  downloadMarkdown(entries);
});

// ── View toggle ───────────────────────────────────────────────

function setView(view) {
  currentView = view;
  viewListBtn.classList.toggle("active", view === "list");
  viewFeedBtn.classList.toggle("active", view === "feed");

  const isList = view === "list";
  listEl.hidden = !isList;
  feedEl.hidden = isList;
  searchBarEl.hidden = !isList;
  actionsBarEl.hidden = !isList;

  if (!isList) {
    try { renderFeed(); } catch (e) { feedEl.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(e.message)}</p></div>`; }
  }
}

viewListBtn.addEventListener("click", () => setView("list"));
viewFeedBtn.addEventListener("click", () => setView("feed"));

// ── Feed view ─────────────────────────────────────────────────

function renderFeed() {
  const entries = Object.values(allBookmarks);
  const total = entries.length;

  if (total === 0) {
    feedEl.innerHTML = `<div class="empty-state"><p>No bookmarks to analyze yet.</p></div>`;
    return;
  }

  // Platform breakdown
  const platforms = { farcaster: 0, twitter: 0 };
  // Author counts (keyed by username for search, display name for label)
  const authorData = {}; // username → { display, count }
  // Topic counts
  const topicCounts = {};

  for (const b of entries) {
    const platform = getBookmarkPlatform(b);
    platforms[platform] = (platforms[platform] || 0) + 1;

    const author = extractBookmarkAuthor(b);
    const username = extractBookmarkAuthorUsername(b) || author;
    if (!authorData[username]) authorData[username] = { display: author, count: 0, platforms: {} };
    authorData[username].count++;
    authorData[username].platforms[platform] = (authorData[username].platforms[platform] || 0) + 1;

    const text = extractBookmarkText(b);
    const topics = detectExportTopics(text);
    for (const t of topics) {
      const label = EXPORT_TOPICS[t]?.label || t;
      topicCounts[label] = (topicCounts[label] || 0) + 1;
    }
  }

  // Top authors (top 10)
  const topAuthors = Object.entries(authorData)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  const maxAuthorCount = topAuthors[0]?.[1]?.count || 1;

  // Topics sorted
  const topTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1]);

  let html = "";

  // Stats grid
  html += `<div class="feed-section">
    <div class="feed-stat-grid">
      <div class="feed-stat-box">
        <div class="feed-stat-number">${total}</div>
        <div class="feed-stat-label">Total bookmarks</div>
      </div>
      <div class="feed-stat-box">
        <div class="feed-stat-number">${Object.keys(authorData).length}</div>
        <div class="feed-stat-label">Unique authors</div>
      </div>
      <div class="feed-stat-box">
        <div class="feed-stat-number" style="color:#7c3aed">${platforms.farcaster || 0}</div>
        <div class="feed-stat-label">Farcaster</div>
      </div>
      <div class="feed-stat-box">
        <div class="feed-stat-number" style="color:#111827">${platforms.twitter || 0}</div>
        <div class="feed-stat-label">Twitter / X</div>
      </div>
    </div>
  </div>`;

  // Topics
  if (topTopics.length > 0) {
    html += `<div class="feed-section">
      <div class="feed-section-title">By topic</div>
      <div class="feed-card">
        ${topTopics.map(([label, count]) =>
          `<span class="feed-topic-pill" data-topic="${escapeAttr(label)}" style="cursor:pointer">${escapeHtml(label)} <span style="opacity:0.6">${count}</span></span>`
        ).join("")}
      </div>
    </div>`;
  }

  // Top authors
  html += `<div class="feed-section">
    <div class="feed-section-title">Most bookmarked authors</div>
    <div class="feed-card">
      ${topAuthors.map(([username, data]) => {
        const pct = Math.round((data.count / maxAuthorCount) * 100);
        const dominant = (data.platforms.twitter || 0) >= (data.platforms.farcaster || 0) ? "twitter" : "farcaster";
        return `<div class="feed-row" data-author="${escapeAttr(username)}" style="cursor:pointer">
          <span class="feed-row-label">${escapeHtml(data.display)}</span>
          <div class="feed-bar-wrap"><div class="feed-bar ${dominant}" style="width:${pct}%"></div></div>
          <span class="feed-row-value">${data.count}</span>
        </div>`;
      }).join("")}
    </div>
  </div>`;

  feedEl.innerHTML = html;

  // Wire up clicks
  feedEl.querySelectorAll("[data-author]").forEach((el) => {
    el.addEventListener("click", () => searchFor(`from:${el.dataset.author}`));
  });
  feedEl.querySelectorAll("[data-topic]").forEach((el) => {
    el.addEventListener("click", () => searchFor(`topic:${el.dataset.topic}`));
  });
}

// ── Util ──────────────────────────────────────────────────────

function flash(btn, msg) {
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = "Sync All"; btn.disabled = false; }, 3000);
}

// ── Start ─────────────────────────────────────────────────────

init();
