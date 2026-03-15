/**
 * Farcaster bookmarks adapter.
 *
 * Reads intercepted data from window.__FC_EXPORT__ (set by intercept.js)
 * and uses the captured auth headers to paginate through all bookmarks.
 */

const ENDPOINT = "https://farcaster.xyz/~api/v2/bookmarked-casts";
const DEFAULT_LIMIT = 100;
const FALLBACK_LIMIT = 15;

const FarcasterAdapter = {
  canHandle(url) {
    try {
      const u = typeof url === "string" ? new URL(url) : url;
      return u.hostname === "farcaster.xyz";
    } catch {
      return false;
    }
  },

  isBookmarksPage(url) {
    try {
      const u = typeof url === "string" ? new URL(url) : url;
      return u.hostname === "farcaster.xyz" && u.pathname.startsWith("/~/bookmarks");
    } catch {
      return false;
    }
  },

  async exportAll(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: exportFromIntercepted,
      args: [ENDPOINT, DEFAULT_LIMIT, FALLBACK_LIMIT],
      world: "MAIN",
    });

    if (!results || !results[0]) throw new Error("Script injection failed");
    return results[0].result;
  },
};

/**
 * Runs in MAIN world. Reads intercepted data and paginates.
 */
async function exportFromIntercepted(endpoint, defaultLimit, fallbackLimit) {
  const fc = window.__FC_EXPORT__;
  const diag = {
    endpoint,
    pagesLoaded: 0,
    itemsCollected: 0,
    limitUsed: defaultLimit,
    interceptReady: !!fc?.ready,
    headersFound: !!fc?.headers,
    headerKeys: fc?.headers ? Object.keys(fc.headers) : [],
    initialBookmarks: fc?.bookmarks?.length || 0,
    responseShape: fc?.responseShape || [],
  };

  if (!fc || !fc.headers) {
    return {
      error: "Auth headers not captured yet. Please refresh the bookmarks page (Cmd+R / Ctrl+R) and wait for it to fully load, then try again.",
      items: [],
      diagnostics: diag,
    };
  }

  const seen = new Set();
  const items = [];

  // Start with already-intercepted bookmarks
  if (fc.bookmarks && fc.bookmarks.length > 0) {
    for (const cast of fc.bookmarks) {
      const id = cast.hash || cast.castHash || cast.id || JSON.stringify(cast).slice(0, 80);
      if (!seen.has(id)) {
        seen.add(id);
        items.push(cast);
      }
    }
    diag.pagesLoaded++;
  }

  // Continue paginating from where the page left off
  let cursor = fc.cursor || null;
  let limit = defaultLimit;

  // If we had no initial bookmarks, start fresh
  if (items.length === 0) {
    cursor = null;
  }

  try {
    let firstOwnPage = true;

    while (true) {
      // If no cursor and we already have items from interception, we're done
      // (unless we need to start fresh)
      if (!cursor && items.length > 0) break;

      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);

      const url = `${endpoint}?${params}`;
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          ...fc.headers,
          "Accept": "application/json",
        },
      });

      if (firstOwnPage && !res.ok && limit !== fallbackLimit) {
        limit = fallbackLimit;
        diag.limitUsed = limit;
        continue;
      }
      firstOwnPage = false;

      if (!res.ok) {
        // If we already have intercepted items, return those
        if (items.length > 0) {
          diag.note = `Pagination stopped at ${res.status}, returning intercepted items`;
          break;
        }
        return { error: `API returned ${res.status}: ${res.statusText}`, items, diagnostics: diag };
      }

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return { error: `Not JSON: ${text.slice(0, 200)}`, items, diagnostics: diag };
      }

      diag.pagesLoaded++;

      // Find the array of casts — walk nested structures too
      let casts = null;
      if (Array.isArray(data)) {
        casts = data;
      } else {
        // Try known keys first
        for (const key of ["casts", "bookmarks", "items", "data", "result"]) {
          const val = data[key];
          if (Array.isArray(val)) { casts = val; diag.arrayKey = key; break; }
          // One level deeper
          if (val && typeof val === "object" && !Array.isArray(val)) {
            for (const subkey of Object.keys(val)) {
              if (Array.isArray(val[subkey])) {
                casts = val[subkey];
                diag.arrayKey = `${key}.${subkey}`;
                break;
              }
            }
            if (casts) break;
          }
        }
        // Try any top-level array
        if (!casts) {
          for (const key of Object.keys(data)) {
            if (Array.isArray(data[key])) {
              casts = data[key];
              diag.arrayKey = key;
              break;
            }
          }
        }
      }

      if (!Array.isArray(casts) || casts.length === 0) break;

      for (const cast of casts) {
        const id = cast.hash || cast.castHash || cast.id || JSON.stringify(cast).slice(0, 80);
        if (!seen.has(id)) {
          seen.add(id);
          items.push(cast);
        }
      }

      cursor = data.cursor || data.next?.cursor || data.nextCursor ||
        data.pagination?.cursor || data.meta?.next_cursor || null;
      if (!cursor) break;
    }

    diag.itemsCollected = items.length;
    return { items, diagnostics: diag };
  } catch (e) {
    if (items.length > 0) {
      diag.itemsCollected = items.length;
      diag.note = `Pagination error: ${e.message}, returning partial results`;
      return { items, diagnostics: diag };
    }
    return { error: e.message, items: [], diagnostics: diag };
  }
}
