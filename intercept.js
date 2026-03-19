/**
 * Runs in MAIN world at document_start on farcaster.xyz.
 *
 * Two jobs:
 *   1. Build a cast cache from ALL API responses — content.js uses this
 *      to enrich bookmark records with full cast data (author, text, embeds)
 *   2. Backup bookmark detection via fetch interception (content.js DOM
 *      observation is the primary layer)
 *
 * The cast cache is the key value here. Every API response that flows
 * through fetch gets walked, and anything that looks like a cast
 * (has hash + author/text) gets cached. When content.js detects a
 * bookmark click, it asks us for the cast data by hash.
 */
(function () {
  const DEBUG = false;
  function log(...args) {
    if (DEBUG || window.__FC_EXPORT__?.debug) console.log("[FC-BM:main]", ...args);
  }

  // ── Cast cache: hash → cast object ──
  const castCache = {};

  window.__FC_EXPORT__ = {
    headers: null,
    bookmarks: [],
    ready: false,
    castCache,
    debug: false,
  };

  // ── Respond to cast data lookups from content.js ───────────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data) return;

    if (event.data.type === "FC_CAST_LOOKUP") {
      const cast = castCache[event.data.castHash] || null;
      window.postMessage({
        type: event.data.nonce,
        castData: cast,
      }, "*");
      log("Cast lookup:", event.data.castHash, cast ? "HIT" : "MISS");
    }
  });

  // ── Fetch interception ─────────────────────────────────────

  const originalFetch = window.fetch;

  function patchedFetch(...args) {
    const req = args[0];
    const init = args[1] || {};
    const url = typeof req === "string" ? req : req?.url || "";
    const method = (init.method || (req instanceof Request ? req.method : "GET")).toUpperCase();

    // Capture auth headers
    if (url.includes("~api")) {
      captureHeaders(init, req);
    }

    // Backup bookmark detection (content.js DOM detection is primary)
    const urlLower = url.toLowerCase();
    if (method !== "GET" && url.includes("~api") && urlLower.includes("bookmark")) {
      log("Fetch bookmark detected (backup):", method, url);
      return handleBookmarkFetch(args, url, method, init);
    }

    // Cache casts from all API responses
    if (url.includes("~api")) {
      return originalFetch.apply(this, args).then(async (response) => {
        try {
          const cloned = response.clone();
          const data = await cloned.json();
          cacheCastsFromResponse(data);

          if (url.includes("bookmarked-casts")) {
            const casts = findCastArray(data);
            if (casts.length > 0) window.__FC_EXPORT__.bookmarks.push(...casts);
            window.__FC_EXPORT__.cursor = data.cursor || data.next?.cursor || data.nextCursor || null;
            window.__FC_EXPORT__.responseShape = Object.keys(data);
            window.__FC_EXPORT__.ready = true;
          }
        } catch (e) { /* not JSON */ }
        return response;
      });
    }

    return originalFetch.apply(this, args);
  }

  async function handleBookmarkFetch(args, url, method, init) {
    // Parse body
    let bodyData = null;
    if (init.body && typeof init.body === "string") {
      try { bodyData = JSON.parse(init.body); } catch (e) {}
    } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
      try { bodyData = JSON.parse(new TextDecoder().decode(init.body)); } catch (e) {}
    }

    const response = await originalFetch.apply(this, args);
    try {
      if (!response.ok) return response;
      const cloned = response.clone();
      let respData = {};
      try { respData = await cloned.json(); } catch (e) {}

      const urlLower = url.toLowerCase();
      const bodyStr = init.body ? String(init.body).toLowerCase() : "";
      const isRemove = urlLower.includes("unbookmark") ||
        urlLower.includes("remove") || method === "DELETE" ||
        bodyStr.includes("unbookmark");

      const castHash = bodyData?.castHash || bodyData?.hash ||
        bodyData?.cast_hash || bodyData?.castId ||
        bodyData?.targetCastHash ||
        respData?.castHash || respData?.hash ||
        respData?.cast?.hash || null;

      if (castHash) {
        const castData = respData?.cast || castCache[castHash] || null;
        window.postMessage({
          type: "FC_BOOKMARK_ACTION",
          action: isRemove ? "remove" : "add",
          castHash,
          castData: isRemove ? null : (castData || { hash: castHash }),
          url: window.location.href,
          timestamp: new Date().toISOString(),
        }, "*");
        log("Backup: posted FC_BOOKMARK_ACTION:", isRemove ? "remove" : "add", castHash);
      }
    } catch (e) {
      log("Backup: error processing bookmark response:", e);
    }
    return response;
  }

  // Resist page overwriting our patch
  try {
    Object.defineProperty(window, "fetch", {
      get() { return patchedFetch; },
      set() { log("Page tried to overwrite fetch — blocked"); },
      configurable: true,
    });
  } catch (e) {
    // Fallback: simple assignment
    window.fetch = patchedFetch;
  }

  // ── Helpers ────────────────────────────────────────────────

  function captureHeaders(init, req) {
    const headers = {};
    const h = init.headers || (req instanceof Request ? req.headers : null);
    if (h instanceof Headers) {
      h.forEach((v, k) => { headers[k] = v; });
    } else if (h && typeof h === "object") {
      Object.assign(headers, h);
    }
    if (Object.keys(headers).length > 0) {
      window.__FC_EXPORT__.headers = headers;
    }
  }

  function cacheCastsFromResponse(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 6 || !obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const item of obj) cacheCastsFromResponse(item, depth + 1);
      return;
    }

    if (obj.hash && typeof obj.hash === "string" && (obj.author || obj.text)) {
      castCache[obj.hash] = obj;
    }

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === "object") {
        cacheCastsFromResponse(val, depth + 1);
      }
    }
  }

  function findCastArray(data) {
    if (Array.isArray(data)) return data;
    for (const key of ["casts", "bookmarks", "items", "data", "result"]) {
      const val = data[key];
      if (Array.isArray(val)) return val;
      if (val && typeof val === "object" && !Array.isArray(val)) {
        for (const sub of Object.keys(val)) {
          if (Array.isArray(val[sub])) return val[sub];
        }
      }
    }
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key])) return data[key];
    }
    return [];
  }

  log("MAIN world loaded — cast cache + backup fetch intercept active");
})();
