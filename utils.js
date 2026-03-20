/**
 * Shared bookmark normalization and export helpers.
 */

// Keep JSON-derived fields aligned with the Obsidian topic vocabulary.
const EXPORT_TOPICS = {
  ai: { label: "AI", keywords: ["ai", "artificial intelligence", "llm", "gpt", "claude", "machine learning", "neural", "transformer"] },
  crypto: { label: "Crypto", keywords: ["crypto", "bitcoin", "btc", "ethereum", "eth", "defi", "dex", "token", "wallet"] },
  zk: { label: "ZK", keywords: ["zk", "zero knowledge", "zkp", "zk-snark", "zk-stark", "validity proof"] },
  governance: { label: "Governance", keywords: ["governance", "voting", "dao", "proposal", "delegate", "council"] },
  infra: { label: "Infrastructure", keywords: ["infra", "infrastructure", "node", "rpc", "indexer", "rollup", "l2", "l1", "sequencer"] },
  social: { label: "Social", keywords: ["social", "farcaster", "lens", "nostr", "social graph", "protocol"] },
  design: { label: "Design", keywords: ["design", "ux", "ui", "interface", "figma", "typography"] },
  culture: { label: "Culture", keywords: ["culture", "art", "music", "nft", "meme", "community"] },
  dev: { label: "Dev", keywords: ["developer", "engineering", "code", "rust", "solidity", "typescript", "api", "sdk", "open source"] },
  product: { label: "Product", keywords: ["product", "launch", "ship", "feature", "roadmap", "users", "growth"] },
  economics: { label: "Economics", keywords: ["economics", "incentive", "tokenomics", "market", "liquidity", "yield"] },
  regulation: { label: "Regulation", keywords: ["regulation", "sec", "compliance", "legal", "policy", "law"] },
  privacy: { label: "Privacy", keywords: ["privacy", "encryption", "e2ee", "anonymity", "surveillance"] },
  identity: { label: "Identity", keywords: ["identity", "did", "ens", "attestation", "credential", "soulbound"] },
};

function platformLabel(platform) {
  return platform === "twitter" ? "Twitter" : "Farcaster";
}

function sanitizeExportKey(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function detectExportTopics(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];

  for (const [key, topic] of Object.entries(EXPORT_TOPICS)) {
    for (const keyword of topic.keywords) {
      if (lower.includes(keyword)) {
        found.push(key);
        break;
      }
    }
  }

  return found;
}

function getBookmarkRawData(record) {
  return record?.rawData || record?.castData || null;
}

function getBookmarkPlatform(record) {
  if (record?.platform) return record.platform;
  const raw = getBookmarkRawData(record);
  if (record?.castHash || raw?.hash || raw?.cast?.hash) return "farcaster";
  if (record?.itemId && /^\d+$/.test(String(record.itemId))) return "twitter";
  if (raw?.rest_id || raw?.legacy?.id_str || raw?.legacy?.full_text || raw?.core?.user_results) return "twitter";
  return "farcaster";
}

function getBookmarkItemId(record) {
  const platform = getBookmarkPlatform(record);
  const raw = getBookmarkRawData(record);
  if (platform === "twitter") {
    return record?.itemId || raw?.rest_id || raw?.legacy?.id_str || null;
  }
  return record?.itemId || record?.castHash || raw?.hash || raw?.cast?.hash || null;
}

function getBookmarkId(record) {
  const itemId = getBookmarkItemId(record);
  if (!itemId) return record?.id || null;
  return record?.id || `${getBookmarkPlatform(record)}:${itemId}`;
}

function normalizeTwitterTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function extractTwitterTweet(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.__typename === "TweetWithVisibilityResults" && raw.tweet) return raw.tweet;
  if (raw.__typename === "Tweet" && raw.rest_id) return raw;
  if (raw.rest_id && raw.legacy) return raw;
  if (raw.tweet?.rest_id) return raw.tweet;
  if (raw.result) return extractTwitterTweet(raw.result);
  return null;
}

function getTwitterUser(raw) {
  const tweet = extractTwitterTweet(raw) || raw;
  return tweet?.core?.user_results?.result || null;
}

function getTwitterUserCore(raw) {
  const user = getTwitterUser(raw);
  return user?.core || null;
}

function getTwitterUserLegacy(raw) {
  const user = getTwitterUser(raw);
  return user?.legacy || null;
}

function normalizeStoredBookmark(platform, raw, options = {}) {
  if (!raw) return null;

  if (platform === "twitter") {
    const tweet = extractTwitterTweet(raw);
    const itemId = tweet?.rest_id || raw?.rest_id || raw?.legacy?.id_str || null;
    if (!itemId) return null;
    const publishedAt = normalizeTwitterTimestamp(tweet?.legacy?.created_at);
    return {
      id: `twitter:${itemId}`,
      platform: "twitter",
      itemId,
      rawData: tweet || raw,
      saved_at: options.savedAt || publishedAt || new Date().toISOString(),
      published_at: publishedAt,
      captured_via: options.capturedVia || "sync",
    };
  }

  const itemId = raw.hash || raw.castHash || raw.cast_hash || null;
  if (!itemId) return null;
  return {
    id: `farcaster:${itemId}`,
    platform: "farcaster",
    itemId,
    castHash: itemId,
    rawData: raw,
    saved_at: options.savedAt || raw.savedAt || raw.saved_at || raw.bookmarkedAt || raw.timestamp || new Date().toISOString(),
    published_at: raw.timestamp || raw.publishedAt || raw.published_at || null,
    captured_via: options.capturedVia || "sync",
  };
}

function extractBookmarkText(record) {
  const raw = getBookmarkRawData(record);
  if (!raw) return "";
  if (getBookmarkPlatform(record) === "twitter") {
    const tweet = extractTwitterTweet(raw);
    return tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text || "";
  }
  return raw.text || raw.body?.text || raw.cast?.text || raw.result?.cast?.text || "";
}

function extractBookmarkAuthor(record) {
  const raw = getBookmarkRawData(record);
  if (!raw) return "Unknown";
  if (getBookmarkPlatform(record) === "twitter") {
    const userCore = getTwitterUserCore(raw);
    const userLegacy = getTwitterUserLegacy(raw);
    return userCore?.name || userLegacy?.name || userCore?.screen_name || userLegacy?.screen_name || "Unknown";
  }
  const author = raw.author || raw.user || raw.cast?.author || raw.result?.cast?.author || {};
  return author.displayName || author.display_name || author.username || (author.fid ? `fid:${author.fid}` : "Unknown");
}

function extractBookmarkAuthorUsername(record) {
  const raw = getBookmarkRawData(record);
  if (!raw) return null;
  if (getBookmarkPlatform(record) === "twitter") {
    const userCore = getTwitterUserCore(raw);
    const userLegacy = getTwitterUserLegacy(raw);
    return userCore?.screen_name || userLegacy?.screen_name || null;
  }
  const author = raw.author || raw.user || raw.cast?.author || raw.result?.cast?.author || {};
  return author.username || null;
}

function extractBookmarkAuthorId(record) {
  const raw = getBookmarkRawData(record);
  if (!raw) return null;
  if (getBookmarkPlatform(record) === "twitter") {
    const user = getTwitterUser(raw);
    return user?.rest_id || raw?.legacy?.user_id_str || null;
  }
  const author = raw.author || raw.user || raw.cast?.author || raw.result?.cast?.author || {};
  return author.fid || raw.authorFid || null;
}

function extractBookmarkAuthorMeta(record) {
  const platform = getBookmarkPlatform(record);
  const username = extractBookmarkAuthorUsername(record);
  if (platform === "twitter") return username ? `@${username}` : null;
  const authorId = extractBookmarkAuthorId(record);
  return authorId ? `#${authorId}` : null;
}

function buildAuthorKey(record) {
  const platform = getBookmarkPlatform(record);
  const username = extractBookmarkAuthorUsername(record);
  const authorId = extractBookmarkAuthorId(record);
  const author = extractBookmarkAuthor(record);
  return sanitizeExportKey(`${platform}-${username || authorId || author}`);
}

function extractBookmarkPublishedAt(record) {
  if (record?.published_at) return record.published_at;
  const raw = getBookmarkRawData(record);
  if (!raw) return null;
  if (getBookmarkPlatform(record) === "twitter") {
    const tweet = extractTwitterTweet(raw);
    return normalizeTwitterTimestamp(tweet?.legacy?.created_at);
  }
  return raw.timestamp || raw.publishedAt || raw.published_at || null;
}

function extractBookmarkUrl(record) {
  if (record?.url) return record.url;
  const raw = getBookmarkRawData(record);
  if (!raw) return null;
  if (getBookmarkPlatform(record) === "twitter") {
    const tweet = extractTwitterTweet(raw);
    const username = extractBookmarkAuthorUsername(record);
    const itemId = getBookmarkItemId(record);
    if (username && itemId) return `https://x.com/${username}/status/${itemId}`;
    if (tweet?.legacy?.quoted_status_permalink?.expanded) return tweet.legacy.quoted_status_permalink.expanded;
    return null;
  }
  const username = extractBookmarkAuthorUsername(record);
  const itemId = getBookmarkItemId(record);
  if (username && itemId) return `https://farcaster.xyz/${username}/${String(itemId).slice(0, 10)}`;
  return null;
}

function extractBookmarkEmbeds(record) {
  const raw = getBookmarkRawData(record);
  if (!raw) return [];

  if (getBookmarkPlatform(record) === "twitter") {
    const tweet = extractTwitterTweet(raw);
    const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];
    const urls = tweet?.legacy?.entities?.urls || [];
    const embeds = [];

    for (const item of media) {
      const url = item.media_url_https || item.expanded_url || item.url || null;
      if (!url) continue;
      embeds.push({ type: item.type || "media", url });
    }

    for (const item of urls) {
      const url = item.expanded_url || item.url || null;
      if (!url) continue;
      embeds.push({ type: "url", url });
    }

    return dedupeEmbeds(embeds);
  }

  let rawEmbeds = raw.embeds || raw.body?.embeds || [];
  if (!Array.isArray(rawEmbeds)) {
    rawEmbeds = typeof rawEmbeds === "object" ? Object.values(rawEmbeds) : [];
  }

  return dedupeEmbeds(rawEmbeds.map((item) => {
    if (typeof item === "string") return { type: "url", url: item };
    const url = item.url || item.uri || item.openGraph?.url || null;
    let type = item.type || "unknown";
    if (!item.type && url) {
      if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) type = "image";
      else if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) type = "video";
      else type = "url";
    }
    return { type, url };
  }));
}

function dedupeEmbeds(embeds) {
  const seen = new Set();
  return embeds.filter((embed) => {
    if (!embed?.url || seen.has(embed.url)) return false;
    seen.add(embed.url);
    return true;
  });
}

function normalizeQuotedTwitterItem(raw) {
  const tweet = extractTwitterTweet(raw);
  if (!tweet?.rest_id) return null;
  const record = {
    platform: "twitter",
    itemId: tweet.rest_id,
    rawData: tweet,
    published_at: normalizeTwitterTimestamp(tweet?.legacy?.created_at),
  };
  return {
    platform: "twitter",
    item_id: tweet.rest_id,
    url: extractBookmarkUrl(record),
    author_username: extractBookmarkAuthorUsername(record),
    author_display_name: extractBookmarkAuthor(record),
    text: extractBookmarkText(record),
    embeds: extractBookmarkEmbeds(record),
    published_at: extractBookmarkPublishedAt(record),
  };
}

function normalizeQuotedFarcasterItem(raw) {
  if (!raw?.hash) return null;
  const record = {
    platform: "farcaster",
    itemId: raw.hash,
    castHash: raw.hash,
    rawData: raw,
    published_at: raw.timestamp || null,
  };
  return {
    platform: "farcaster",
    item_id: raw.hash,
    url: extractBookmarkUrl(record),
    author_username: extractBookmarkAuthorUsername(record),
    author_display_name: extractBookmarkAuthor(record),
    text: extractBookmarkText(record),
    embeds: extractBookmarkEmbeds(record),
    published_at: extractBookmarkPublishedAt(record),
  };
}

function extractBookmarkQuote(record) {
  const raw = getBookmarkRawData(record);
  if (!raw) return null;

  if (getBookmarkPlatform(record) === "twitter") {
    const tweet = extractTwitterTweet(raw);
    const quoted = tweet?.quoted_status_result?.result || tweet?.quotedRefResult?.result || null;
    return normalizeQuotedTwitterItem(quoted);
  }

  const quotedCast = raw?.embeds?.casts?.[0] || raw?.body?.embeds?.casts?.[0] || null;
  return normalizeQuotedFarcasterItem(quotedCast);
}

function normalizeExportItem(record) {
  const platform = getBookmarkPlatform(record);
  const itemId = getBookmarkItemId(record);
  const url = extractBookmarkUrl(record);
  const embeds = extractBookmarkEmbeds(record);
  const text = extractBookmarkText(record);
  const quotedItem = extractBookmarkQuote(record);
  const topicKeys = detectExportTopics(text);
  const sourceLabel = platformLabel(platform);

  return {
    platform,
    item_id: itemId,
    url,
    author_id: extractBookmarkAuthorId(record),
    author_username: extractBookmarkAuthorUsername(record),
    author_display_name: extractBookmarkAuthor(record),
    text,
    embeds,
    quoted_item: quotedItem,
    canonical_url: url || embeds[0]?.url || null,
    published_at: extractBookmarkPublishedAt(record),
    saved_at: record?.saved_at || null,
    scraped_at: new Date().toISOString(),
    derived: {
      record_type: "bookmark",
      source_key: platform,
      source_label: sourceLabel,
      source_link: `Sources/${sourceLabel}`,
      author_key: buildAuthorKey(record),
      topic_keys: topicKeys,
      topic_labels: topicKeys.map((key) => EXPORT_TOPICS[key]?.label || key),
      topic_links: topicKeys.map((key) => `Topics/${EXPORT_TOPICS[key]?.label || key}`),
      has_quote: Boolean(quotedItem),
    },
    raw: getBookmarkRawData(record),
  };
}

function buildExportPayload(records, diagnostics) {
  const items = (records || []).map(normalizeExportItem).filter((item) => item.item_id);
  const platforms = [...new Set(items.map((item) => item.platform))];
  const source = platforms.length === 1 ? platforms[0] : "mixed";

  return {
    source,
    exported_at: new Date().toISOString(),
    meta: {
      extractor: "fc-bookmarks-exporter",
      version: "0.4.0",
      path: diagnostics?.path || "archive",
      route: diagnostics?.route || null,
      platforms,
      derived_fields: [
        "derived.record_type",
        "derived.source_key",
        "derived.source_label",
        "derived.source_link",
        "derived.author_key",
        "derived.topic_keys",
        "derived.topic_labels",
        "derived.topic_links",
        "derived.has_quote",
      ],
    },
    items,
  };
}

function downloadMarkdown(records) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# Bookmarks — ${date}\n`];

  for (const record of records) {
    const author = extractBookmarkAuthor(record);
    const username = extractBookmarkAuthorUsername(record);
    const text = extractBookmarkText(record);
    const url = extractBookmarkUrl(record);
    const platform = getBookmarkPlatform(record);
    const savedAt = record.saved_at || "";
    const publishedAt = extractBookmarkPublishedAt(record) || "";
    const topics = detectExportTopics(text);

    lines.push(`## ${author}${username ? ` (@${username})` : ""}`);
    lines.push("");
    if (text) lines.push(text);
    lines.push("");
    if (url) lines.push(`[View on ${platformLabel(platform)}](${url})`);
    if (topics.length) lines.push(`**Topics:** ${topics.map((k) => EXPORT_TOPICS[k]?.label || k).join(", ")}`);
    lines.push(`**Platform:** ${platformLabel(platform)} | **Saved:** ${savedAt.slice(0, 10) || "—"} | **Posted:** ${publishedAt.slice(0, 10) || "—"}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const filename = `bookmarks-${date}.md`;
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
  return filename;
}

function downloadJSON(payload) {
  const date = new Date().toISOString().slice(0, 10);
  const prefix = payload.source === "mixed" ? "bookmarks" : `${payload.source}-bookmarks`;
  const filename = `${prefix}-${date}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filename;
}
