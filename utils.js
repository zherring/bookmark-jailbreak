/**
 * Normalization and download helpers.
 */

function normalizeItem(raw) {
  const author = raw.author || raw.user || {};
  const hash = raw.hash || raw.castHash || null;
  const authorFid = author.fid ?? raw.authorFid ?? null;
  const authorUsername = author.username ?? raw.authorUsername ?? null;
  const authorDisplayName = author.displayName ?? author.display_name ?? null;
  const text = raw.text ?? raw.body?.text ?? null;

  // Embeds — may be an array, object, or missing
  let rawEmbeds = raw.embeds || raw.body?.embeds || [];
  if (!Array.isArray(rawEmbeds)) {
    rawEmbeds = typeof rawEmbeds === "object" ? Object.values(rawEmbeds) : [];
  }
  const embeds = rawEmbeds.map((e) => {
    if (typeof e === "string") return { type: "url", url: e };
    const url = e.url || e.uri || e.openGraph?.url || null;
    let type = "unknown";
    if (e.type) {
      type = e.type;
    } else if (e.castId || e.cast_id) {
      type = "cast";
    } else if (url && /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) {
      type = "image";
    } else if (url && /\.(mp4|webm|mov)(\?|$)/i.test(url)) {
      type = "video";
    } else if (url) {
      type = "url";
    }
    return { type, url };
  });

  // Build cast URL
  let castUrl = null;
  if (hash && authorUsername) {
    castUrl = `https://farcaster.xyz/${authorUsername}/${hash.slice(0, 10)}`;
  }

  // Canonical URL: prefer explicit, then first embed url, then cast url
  const canonicalUrl = raw.canonicalUrl || raw.canonical_url || (embeds.length > 0 ? embeds[0].url : null) || castUrl;

  return {
    saved_id: raw.bookmarkId || raw.savedId || null,
    cast_hash: hash,
    cast_url: castUrl,
    author_fid: authorFid,
    author_username: authorUsername,
    author_display_name: authorDisplayName,
    text,
    embeds,
    canonical_url: canonicalUrl,
    published_at: raw.timestamp || raw.publishedAt || raw.published_at || null,
    saved_at: raw.savedAt || raw.saved_at || raw.bookmarkedAt || null,
    scraped_at: new Date().toISOString(),
    raw,
  };
}

function buildExportPayload(items, diagnostics) {
  return {
    source: "farcaster",
    exported_at: new Date().toISOString(),
    meta: {
      route: "https://farcaster.xyz/~/bookmarks",
      extractor: "farcaster-bookmarks-exporter",
      version: "0.1.0",
      path: diagnostics.fallbackUsed ? "dom" : "api",
    },
    items: items.map(normalizeItem),
  };
}

function downloadJSON(payload) {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `farcaster-bookmarks-${date}.json`;
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
