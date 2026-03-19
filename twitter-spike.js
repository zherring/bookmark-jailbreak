/**
 * Twitter/X bookmarks spike probe.
 *
 * Runs in the MAIN world so it can see the same network primitives as the page.
 * It records bookmark timeline diagnostics, caches tweet objects from GraphQL
 * responses, and emits live bookmark add/remove actions when bookmark mutations
 * succeed.
 */
(function () {
  const MAX_EVENTS = 20;

  const spike = window.__TWITTER_BOOKMARK_SPIKE__ = window.__TWITTER_BOOKMARK_SPIKE__ || {
    startedAt: new Date().toISOString(),
    host: window.location.host,
    ready: false,
    matchedUrls: 0,
    transports: { xhr: false, fetch: false },
    tweetCache: {},
    bookmarkOrder: [],
    seenTweetIds: {},
    pendingEnrichmentIds: {},
    lastTweetContext: null,
    events: [],
    lastError: null,
  };

  if (spike.installed) return;
  spike.installed = true;

  function shouldInspect(url) {
    return /\/i\/api\/graphql\/.+\/Bookmarks(?:\?|$)/.test(url);
  }

  function shouldInspectGraphQL(url) {
    return /\/i\/api\/graphql\//.test(url);
  }

  function isBookmarkMutation(url, method) {
    if (!shouldInspectGraphQL(url) || String(method).toUpperCase() === "GET") return false;
    const op = (extractOperationName(url) || "").toLowerCase();
    return op.includes("bookmark");
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function extractOperationName(url) {
    try {
      const pathname = new URL(url, window.location.origin).pathname;
      const parts = pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || null;
    } catch {
      return null;
    }
  }

  function extractTweetRestId(result) {
    if (!result || typeof result !== "object") return null;
    if (typeof result.rest_id === "string") return result.rest_id;
    if (typeof result.tweet?.rest_id === "string") return result.tweet.rest_id;
    if (typeof result.result?.rest_id === "string") return result.result.rest_id;
    return null;
  }

  function extractTweet(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "TweetWithVisibilityResults" && result.tweet?.rest_id) return result.tweet;
    if (result.__typename === "Tweet" && result.rest_id) return result;
    if (result.rest_id && result.legacy) return result;
    if (result.tweet?.rest_id) return result.tweet;
    if (result.result) return extractTweet(result.result);
    return null;
  }

  function cacheTweet(tweet) {
    if (!tweet?.rest_id) return;
    const existing = spike.tweetCache[tweet.rest_id];
    if (!existing) {
      spike.tweetCache[tweet.rest_id] = tweet;
    } else if (!existing.core?.user_results && tweet.core?.user_results) {
      spike.tweetCache[tweet.rest_id] = tweet;
    } else if (!existing.legacy?.full_text && tweet.legacy?.full_text) {
      spike.tweetCache[tweet.rest_id] = { ...existing, ...tweet };
    }

    if (spike.pendingEnrichmentIds[tweet.rest_id] && isRichTweet(spike.tweetCache[tweet.rest_id])) {
      window.postMessage({
        type: "FC_TWITTER_BOOKMARK_ENRICH",
        itemId: tweet.rest_id,
        rawData: spike.tweetCache[tweet.rest_id],
        url: window.location.href,
        timestamp: new Date().toISOString(),
      }, "*");
      delete spike.pendingEnrichmentIds[tweet.rest_id];
    }
  }

  function isRichTweet(tweet) {
    return !!(tweet?.core?.user_results || tweet?.legacy?.full_text);
  }

  function cacheTweetsFromObject(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 8 || !obj || typeof obj !== "object") return;

    const tweet = extractTweet(obj);
    if (tweet) cacheTweet(tweet);

    if (Array.isArray(obj)) {
      for (const item of obj) cacheTweetsFromObject(item, depth + 1);
      return;
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        cacheTweetsFromObject(value, depth + 1);
      }
    }
  }

  function extractTweetsFromInstructions(instructions) {
    const tweets = [];

    function pushTweet(result) {
      const tweet = extractTweet(result);
      if (tweet?.rest_id) tweets.push(tweet);
    }

    for (const instruction of instructions) {
      if (instruction?.type !== "TimelineAddEntries" || !Array.isArray(instruction.entries)) continue;
      for (const entry of instruction.entries) {
        pushTweet(entry?.content?.itemContent?.tweet_results?.result);

        const moduleItems = entry?.content?.items;
        if (!Array.isArray(moduleItems)) continue;
        for (const moduleItem of moduleItems) {
          pushTweet(moduleItem?.item?.itemContent?.tweet_results?.result);
        }
      }
    }

    return tweets;
  }

  function sampleTweetIds(instructions) {
    const ids = [];
    for (const instruction of instructions) {
      if (instruction?.type !== "TimelineAddEntries" || !Array.isArray(instruction.entries)) continue;
      for (const entry of instruction.entries) {
        if (ids.length >= 5) return ids;

        const item = entry?.content?.itemContent;
        const direct = extractTweetRestId(item?.tweet_results?.result);
        if (direct) {
          ids.push(direct);
          continue;
        }

        const moduleItems = entry?.content?.items;
        if (!Array.isArray(moduleItems)) continue;
        for (const moduleItem of moduleItems) {
          const nested = extractTweetRestId(moduleItem?.item?.itemContent?.tweet_results?.result);
          if (nested) ids.push(nested);
          if (ids.length >= 5) return ids;
        }
      }
    }
    return ids;
  }

  function buildEvent(url, method, status, transport, text) {
    const parsedUrl = new URL(url, window.location.origin);
    const variables = safeJsonParse(parsedUrl.searchParams.get("variables"));
    const features = safeJsonParse(parsedUrl.searchParams.get("features"));
    const fieldToggles = safeJsonParse(parsedUrl.searchParams.get("fieldToggles"));
    const data = safeJsonParse(text);
    const timeline = data?.data?.bookmark_timeline_v2?.timeline;
    const instructions = Array.isArray(timeline?.instructions) ? timeline.instructions : [];

    const addEntries = instructions.filter((instruction) => instruction?.type === "TimelineAddEntries");
    const entryCount = addEntries.reduce((sum, instruction) => {
      return sum + (Array.isArray(instruction.entries) ? instruction.entries.length : 0);
    }, 0);

    return {
      timestamp: new Date().toISOString(),
      transport,
      method,
      status,
      operation: extractOperationName(url),
      path: parsedUrl.pathname,
      hasBookmarkTimeline: !!timeline,
      instructionTypes: instructions.map((instruction) => instruction?.type).filter(Boolean),
      entryCount,
      sampleTweetIds: sampleTweetIds(instructions),
      request: {
        hasVariables: !!variables,
        variablesKeys: variables ? Object.keys(variables).sort() : [],
        cursor: variables?.cursor || null,
        count: variables?.count ?? null,
        hasFeatures: !!features,
        featureKeys: features ? Object.keys(features).sort() : [],
        hasFieldToggles: !!fieldToggles,
      },
      response: {
        topKeys: data && typeof data === "object" ? Object.keys(data) : [],
        rawCursor: data?.cursor || data?.nextCursor || data?.data?.bookmark_timeline_v2?.timeline?.cursor || null,
      },
    };
  }

  function recordEvent(event, tweets) {
    spike.ready = true;
    spike.matchedUrls += 1;
    for (const tweet of tweets) {
      spike.tweetCache[tweet.rest_id] = tweet;
      if (!spike.seenTweetIds[tweet.rest_id]) {
        spike.seenTweetIds[tweet.rest_id] = true;
        spike.bookmarkOrder.push(tweet.rest_id);
      }
    }
    spike.events.unshift(event);
    if (spike.events.length > MAX_EVENTS) spike.events.length = MAX_EVENTS;
    spike.lastError = null;
  }

  function recordError(error, context) {
    spike.lastError = {
      timestamp: new Date().toISOString(),
      context,
      message: error?.message || String(error),
    };
  }

  function parseRequestPayload(body) {
    if (!body) return null;
    if (typeof body === "string") return safeJsonParse(body);
    if (body instanceof URLSearchParams) {
      const out = {};
      body.forEach((value, key) => {
        out[key] = key === "variables" || key === "features" || key === "fieldToggles"
          ? safeJsonParse(value) || value
          : value;
      });
      return out;
    }
    if (body instanceof FormData) {
      const out = {};
      body.forEach((value, key) => { out[key] = value; });
      return out;
    }
    return body;
  }

  function extractMutationItemId(url, body) {
    const parsedUrl = new URL(url, window.location.origin);
    const payload = parseRequestPayload(body);
    const urlVariables = safeJsonParse(parsedUrl.searchParams.get("variables"));
    const variables = payload?.variables || urlVariables || payload || {};
    return variables?.tweet_id || variables?.tweetId || variables?.rest_id || variables?.id || null;
  }

  function emitBookmarkAction(action, itemId) {
    if (!itemId) return;
    const fallbackContext = spike.lastTweetContext?.itemId === itemId ? spike.lastTweetContext.rawData : null;
    const rawData = action === "remove" ? null : (spike.tweetCache[itemId] || fallbackContext || null);
    if (action === "add" && !rawData) {
      spike.pendingEnrichmentIds[itemId] = true;
    }
    window.postMessage({
      type: "FC_TWITTER_BOOKMARK_ACTION",
      action,
      itemId,
      rawData,
      url: window.location.href,
      timestamp: new Date().toISOString(),
    }, "*");
  }

  function parseTweetHref(href) {
    if (!href) return null;
    const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    return { username: match[1], itemId: match[2] };
  }

  function buildTweetFromDom(article) {
    if (!article) return null;

    const statusLink = article.querySelector('a[href*="/status/"]');
    const parsed = parseTweetHref(statusLink?.getAttribute("href") || "");
    if (!parsed?.itemId) return null;

    const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
    const userNameText = article.querySelector('[data-testid="User-Name"]')?.innerText || "";
    const handleMatch = userNameText.match(/@([A-Za-z0-9_]+)/);
    const screenName = handleMatch?.[1] || parsed.username || null;
    const displayName = userNameText
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("@") && !/^\d/.test(part) && !part.includes("·")) || screenName || "Unknown";

    return {
      __typename: "Tweet",
      rest_id: parsed.itemId,
      core: {
        user_results: {
          result: {
            __typename: "User",
            core: {
              name: displayName,
              screen_name: screenName,
            },
            legacy: {},
          },
        },
      },
      legacy: {
        id_str: parsed.itemId,
        full_text: text,
      },
    };
  }

  document.addEventListener("click", (event) => {
    const article = event.target?.closest?.('article[data-testid="tweet"]');
    if (!article) return;
    const tweet = buildTweetFromDom(article);
    if (!tweet) return;
    cacheTweet(tweet);
    spike.lastTweetContext = {
      itemId: tweet.rest_id,
      rawData: tweet,
    };
  }, true);

  function inspectResponse(url, method, status, transport, text) {
    try {
      const data = safeJsonParse(text);
      if (data) cacheTweetsFromObject(data);
      if (!shouldInspect(url)) return;
      const instructions = Array.isArray(data?.data?.bookmark_timeline_v2?.timeline?.instructions)
        ? data.data.bookmark_timeline_v2.timeline.instructions
        : [];
      const tweets = extractTweetsFromInstructions(instructions);
      recordEvent(buildEvent(url, method, status, transport, text), tweets);
    } catch (error) {
      recordError(error, { url, method, status, transport });
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__twSpikeRequest = {
      method: String(method || "GET").toUpperCase(),
      url: typeof url === "string" ? url : String(url),
      body: null,
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__twSpikeRequest;
    if (meta && !this.__twSpikeBound) {
      this.__twSpikeBound = true;
      this.addEventListener("load", () => {
        try {
          const requestUrl = meta.url;
          const requestMethod = meta.method;

          if (shouldInspectGraphQL(requestUrl)) {
            spike.transports.xhr = true;
            inspectResponse(requestUrl, requestMethod, this.status, "xhr", this.responseText || "");
          }

          if (this.status >= 200 && this.status < 400 && isBookmarkMutation(requestUrl, requestMethod)) {
            const operation = (extractOperationName(requestUrl) || "").toLowerCase();
            const action = operation.includes("delete") || operation.includes("remove") || operation.includes("unbookmark")
              ? "remove"
              : "add";
            emitBookmarkAction(action, extractMutationItemId(requestUrl, meta.body));
          }
        } catch (error) {
          recordError(error, { url: meta?.url, method: meta?.method, transport: "xhr" });
        }
      });
    }

    if (meta) meta.body = body;
    return originalSend.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  async function patchedFetch(...args) {
    const req = args[0];
    const init = args[1] || {};
    const url = typeof req === "string" ? req : req?.url || "";
    const method = (init.method || (req instanceof Request ? req.method : "GET")).toUpperCase();
    let body = init.body || null;
    if (!body && req instanceof Request) {
      try {
        body = await req.clone().text();
      } catch {
        body = null;
      }
    }
    const response = await originalFetch.apply(this, args);

    if (shouldInspectGraphQL(url)) {
      spike.transports.fetch = true;
      response.clone().text()
        .then((text) => inspectResponse(url, method, response.status, "fetch", text))
        .catch((error) => recordError(error, { url, method, transport: "fetch" }));
    }

    if (response.ok && isBookmarkMutation(url, method)) {
      const operation = (extractOperationName(url) || "").toLowerCase();
      const action = operation.includes("delete") || operation.includes("remove") || operation.includes("unbookmark")
        ? "remove"
        : "add";
      emitBookmarkAction(action, extractMutationItemId(url, body));
    }

    return response;
  }

  try {
    Object.defineProperty(window, "fetch", {
      get() {
        return patchedFetch;
      },
      set() {
        // Preserve the probe even if the page tries to replace fetch later.
      },
      configurable: true,
    });
  } catch {
    window.fetch = patchedFetch;
  }
})();
