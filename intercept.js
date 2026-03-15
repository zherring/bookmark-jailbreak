/**
 * Runs in MAIN world at document_start on farcaster.xyz.
 * Patches fetch to capture auth headers and response data from ~api calls.
 *
 * Stores captured data on window.__FC_EXPORT__ for the popup to read.
 */
(function () {
  window.__FC_EXPORT__ = {
    headers: null,
    bookmarks: [],
    ready: false,
  };

  const originalFetch = window.fetch;

  window.fetch = function (...args) {
    const req = args[0];
    const init = args[1] || {};
    const url = typeof req === "string" ? req : req?.url || "";

    // Capture headers from any ~api request
    if (url.includes("~api") && !window.__FC_EXPORT__.headers) {
      const headers = {};
      const h = init.headers || (req instanceof Request ? req.headers : null);
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (h && typeof h === "object" && !(h instanceof Headers)) {
        Object.assign(headers, h);
      }
      if (Object.keys(headers).length > 0) {
        window.__FC_EXPORT__.headers = headers;
      }
    }

    // Intercept bookmarked-casts responses to capture initial data
    if (url.includes("bookmarked-casts")) {
      return originalFetch.apply(this, args).then(async (response) => {
        try {
          const cloned = response.clone();
          const data = await cloned.json();
          // Store the response data
          const casts = data.casts || data.bookmarks || data.items || data.result?.casts || data.data || [];
          if (Array.isArray(casts)) {
            window.__FC_EXPORT__.bookmarks.push(...casts);
          }
          // Store pagination info
          window.__FC_EXPORT__.cursor = data.cursor || data.next?.cursor || data.nextCursor || null;
          window.__FC_EXPORT__.responseShape = Object.keys(data);
          window.__FC_EXPORT__.ready = true;
        } catch (e) {
          // Don't break the page
        }
        return response;
      });
    }

    return originalFetch.apply(this, args);
  };
})();
