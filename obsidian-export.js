/**
 * Obsidian vault export — metadata-first graph architecture.
 *
 * Folder structure:
 *   00 Dashboards/
 *     Farcaster Bookmarks.md         ← master dashboard (Dataview-driven)
 *   Sources/
 *     Farcaster.md                   ← source hub
 *   Authors/
 *     {username}.md                  ← one per author
 *   Topics/
 *     {topic}.md                     ← canonical topic nodes
 *   Bookmarks/
 *     farcaster-{hash}.md            ← one per bookmark (stable filename)
 *
 * Design principles (from spec):
 *   - Filenames are stable, keyed on hash not display name
 *   - Hierarchy encoded in frontmatter + wikilinks, not folders
 *   - Topics are first-class, drawn from canonical list
 *   - Frontmatter separates required / optional / enrichment fields
 *   - Dataview dashboards, not graph view, are the primary UX
 *   - LLM enrichment fields are present but empty (ready for future)
 *
 * Platform-agnostic: the same schema works for X/Twitter bookmarks.
 */

// ── Canonical topic list ──────────────────────────────────────
// Controlled vocabulary. New topics are added here, not invented ad hoc.
// Keyword detection seeds initial topics; LLM enrichment refines later.

const CANONICAL_TOPICS = {
  ai:           { label: "AI", keywords: ["ai", "artificial intelligence", "llm", "gpt", "claude", "machine learning", "neural", "transformer"] },
  crypto:       { label: "Crypto", keywords: ["crypto", "bitcoin", "btc", "ethereum", "eth", "defi", "dex", "token", "wallet"] },
  zk:           { label: "ZK", keywords: ["zk", "zero knowledge", "zkp", "zk-snark", "zk-stark", "validity proof"] },
  governance:   { label: "Governance", keywords: ["governance", "voting", "dao", "proposal", "delegate", "council"] },
  infra:        { label: "Infrastructure", keywords: ["infra", "infrastructure", "node", "rpc", "indexer", "rollup", "l2", "l1", "sequencer"] },
  social:       { label: "Social", keywords: ["social", "farcaster", "lens", "nostr", "social graph", "protocol"] },
  design:       { label: "Design", keywords: ["design", "ux", "ui", "interface", "figma", "typography"] },
  culture:      { label: "Culture", keywords: ["culture", "art", "music", "nft", "meme", "community"] },
  dev:          { label: "Dev", keywords: ["developer", "engineering", "code", "rust", "solidity", "typescript", "api", "sdk", "open source"] },
  product:      { label: "Product", keywords: ["product", "launch", "ship", "feature", "roadmap", "users", "growth"] },
  economics:    { label: "Economics", keywords: ["economics", "incentive", "tokenomics", "market", "liquidity", "yield"] },
  regulation:   { label: "Regulation", keywords: ["regulation", "sec", "compliance", "legal", "policy", "law"] },
  privacy:      { label: "Privacy", keywords: ["privacy", "encryption", "e2ee", "anonymity", "surveillance"] },
  identity:     { label: "Identity", keywords: ["identity", "did", "ens", "attestation", "credential", "soulbound"] },
};

// ── Public API ────────────────────────────────────────────────

function exportToObsidian(bookmarks) {
  const entries = Object.values(bookmarks);
  if (entries.length === 0) return;

  const files = {};
  const byAuthor = {};      // author key → { username, fid, displayName, hashes[] }
  const topicHits = {};     // topic key → count (for knowing which topic files to create)

  // ── Pass 1: bookmark files ──
  for (const b of entries) {
    const author    = obExtractAuthor(b);
    const username  = obExtractUsername(b) || sanitizeFilename(author);
    const fid       = obExtractFid(b);
    const text      = obExtractText(b);
    const hash      = b.castHash || "unknown";
    const shortHash = hash.slice(0, 10);
    const castUrl   = obExtractCastUrl(b);
    const savedAt   = b.saved_at ? normalizeTimestamp(b.saved_at) : "";
    const publishedAt = obExtractPublished(b);
    const embeds    = obExtractEmbeds(b);
    const via       = b.captured_via || "unknown";

    // Detect topics from text
    const topics = detectTopics(text);
    for (const t of topics) { topicHits[t] = (topicHits[t] || 0) + 1; }

    // Stable filename: farcaster-{shortHash}
    const fileName = `farcaster-${sanitizeFilename(shortHash)}`;

    // ── Frontmatter ──
    // Required fields
    const fm = {
      record_type: "bookmark",
      source: "[[Farcaster]]",
      author: `[[${username}]]`,
      author_display: author,
      cast_hash: hash,
      saved_at: savedAt,
    };
    // Optional fields
    if (publishedAt) fm.published_at = normalizeTimestamp(publishedAt);
    if (castUrl) fm.cast_url = castUrl;
    if (fid) fm.fid = fid;
    fm.captured_via = via;
    fm.topics = topics.map((t) => `[[${CANONICAL_TOPICS[t].label}]]`);
    fm.embeds = embeds.map((e) => e.url).filter(Boolean);
    fm.tags = ["bookmark", "farcaster"];
    // LLM enrichment fields (empty, ready for future)
    fm.llm_summary = null;
    fm.llm_topics = null;
    fm.llm_entities = null;
    fm.llm_confidence = null;

    let body = yamlBlock(fm) + "\n";
    body += `# Cast by [[${username}]]\n\n`;

    if (text) {
      body += `> ${text.replace(/\n/g, "\n> ")}\n\n`;
    } else {
      body += `> *(no text)*\n\n`;
    }

    if (embeds.length > 0) {
      body += `## Embeds\n\n`;
      for (const e of embeds) {
        if (e.url) body += `- [${e.type}](${e.url})\n`;
      }
      body += `\n`;
    }

    if (topics.length > 0) {
      body += `## Topics\n\n`;
      body += topics.map((t) => `[[${CANONICAL_TOPICS[t].label}]]`).join(" · ") + "\n\n";
    }

    body += `---\n`;
    body += `Source: [[Farcaster]] · Author: [[${username}]]`;
    if (castUrl) body += ` · [View cast](${castUrl})`;
    body += `\n`;

    files[`Bookmarks/${fileName}.md`] = body;

    // Track author
    if (!byAuthor[username]) {
      byAuthor[username] = { displayName: author, username, fid, hashes: [] };
    }
    byAuthor[username].hashes.push(shortHash);
  }

  // ── Pass 2: author files ──
  for (const [key, info] of Object.entries(byAuthor)) {
    const safeKey = sanitizeFilename(key);
    const fm = {
      record_type: "author",
      platform: "farcaster",
      username: info.username,
      display_name: info.displayName,
      fid: info.fid,
      bookmark_count: info.hashes.length,
      tags: ["author", "farcaster"],
    };

    let body = yamlBlock(fm) + "\n";
    body += `# ${info.displayName}\n\n`;
    if (info.username) body += `**@${info.username}**`;
    if (info.fid) body += ` · FID: ${info.fid}`;
    body += ` · Source: [[Farcaster]]\n\n`;

    // Dataview: this author's bookmarks
    body += `## Bookmarks\n\n`;
    body += "```dataview\n";
    body += "TABLE saved_at AS \"Saved\", topics AS \"Topics\"\n";
    body += 'FROM ""\n';
    body += `WHERE record_type = "bookmark" AND author = [[${safeKey}]]\n`;
    body += "SORT saved_at DESC\n";
    body += "```\n\n";

    // Dataview: topic distribution for this author
    body += `## Topic Distribution\n\n`;
    body += "```dataview\n";
    body += "TABLE length(rows) AS \"Count\"\n";
    body += 'FROM ""\n';
    body += `WHERE record_type = "bookmark" AND author = [[${safeKey}]]\n`;
    body += "FLATTEN topics AS topic\n";
    body += "GROUP BY topic\n";
    body += "SORT length(rows) DESC\n";
    body += "```\n\n";

    files[`Authors/${safeKey}.md`] = body;
  }

  // ── Pass 3: topic files ──
  // Create files for all canonical topics that have at least one hit,
  // plus a few seed topics so the structure is clear
  const topicsToCreate = new Set(Object.keys(topicHits));
  // Always create a few core ones so the folder isn't empty
  for (const seed of ["ai", "crypto", "social", "dev", "governance"]) {
    topicsToCreate.add(seed);
  }

  for (const key of topicsToCreate) {
    const topic = CANONICAL_TOPICS[key];
    if (!topic) continue;
    const fm = {
      record_type: "topic",
      label: topic.label,
      aliases: [key],
      tags: ["topic"],
    };

    let body = yamlBlock(fm) + "\n";
    body += `# ${topic.label}\n\n`;

    // Dataview: bookmarks for this topic
    body += `## Bookmarks\n\n`;
    body += "```dataview\n";
    body += "TABLE author AS \"Author\", saved_at AS \"Saved\"\n";
    body += 'FROM ""\n';
    body += `WHERE record_type = "bookmark" AND contains(topics, [[${topic.label}]])\n`;
    body += "SORT saved_at DESC\n";
    body += "```\n\n";

    // Dataview: top authors for this topic
    body += `## Top Authors\n\n`;
    body += "```dataview\n";
    body += "TABLE length(rows) AS \"Bookmarks\"\n";
    body += 'FROM ""\n';
    body += `WHERE record_type = "bookmark" AND contains(topics, [[${topic.label}]])\n`;
    body += "GROUP BY author\n";
    body += "SORT length(rows) DESC\n";
    body += "```\n\n";

    files[`Topics/${topic.label}.md`] = body;
  }

  // ── Source file ──
  {
    const fm = {
      record_type: "source",
      platform: "farcaster",
      url: "https://farcaster.xyz",
      tags: ["source", "platform"],
    };

    let body = yamlBlock(fm) + "\n";
    body += `# Farcaster\n\n`;
    body += `Social protocol. Bookmarks captured via browser extension.\n\n`;

    body += `## Authors\n\n`;
    body += "```dataview\n";
    body += "TABLE bookmark_count AS \"Bookmarks\", fid AS \"FID\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "author" AND platform = "farcaster"\n';
    body += "SORT bookmark_count DESC\n";
    body += "```\n\n";

    body += `## Recent Bookmarks\n\n`;
    body += "```dataview\n";
    body += "TABLE author AS \"Author\", topics AS \"Topics\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "bookmark" AND source = [[Farcaster]]\n';
    body += "SORT saved_at DESC\n";
    body += "LIMIT 20\n";
    body += "```\n\n";

    files["Sources/Farcaster.md"] = body;
  }

  // ── Dashboard ──
  {
    const authorCount = Object.keys(byAuthor).length;
    const topicCount = Object.keys(topicHits).length;

    const fm = {
      record_type: "dashboard",
      exported_at: new Date().toISOString(),
      tags: ["dashboard", "index"],
    };

    let body = yamlBlock(fm) + "\n";
    body += `# Farcaster Bookmarks\n\n`;
    body += `**${entries.length}** bookmarks · **${authorCount}** authors · **${topicCount}** topics\n\n`;

    // Recent bookmarks
    body += `## Recent Bookmarks\n\n`;
    body += "```dataview\n";
    body += "TABLE author AS \"Author\", topics AS \"Topics\", saved_at AS \"Saved\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "bookmark"\n';
    body += "SORT saved_at DESC\n";
    body += "LIMIT 25\n";
    body += "```\n\n";

    // Top authors
    body += `## Top Authors\n\n`;
    body += "```dataview\n";
    body += "TABLE bookmark_count AS \"Bookmarks\", display_name AS \"Name\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "author"\n';
    body += "SORT bookmark_count DESC\n";
    body += "LIMIT 15\n";
    body += "```\n\n";

    // Top topics
    body += `## Top Topics\n\n`;
    body += "```dataview\n";
    body += "TABLE length(rows) AS \"Bookmarks\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "bookmark"\n';
    body += "FLATTEN topics AS topic\n";
    body += "GROUP BY topic\n";
    body += "SORT length(rows) DESC\n";
    body += "```\n\n";

    // Bookmarks by source (future-proofed for X, etc.)
    body += `## By Source\n\n`;
    body += "```dataview\n";
    body += "TABLE length(rows) AS \"Bookmarks\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "bookmark"\n';
    body += "GROUP BY source\n";
    body += "SORT length(rows) DESC\n";
    body += "```\n\n";

    // Bookmarks with no topics (enrichment queue)
    body += `## Needs Topics (enrichment queue)\n\n`;
    body += "```dataview\n";
    body += "TABLE author AS \"Author\", saved_at AS \"Saved\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "bookmark" AND length(topics) = 0\n';
    body += "SORT saved_at DESC\n";
    body += "LIMIT 20\n";
    body += "```\n\n";

    // Bookmarks without LLM summary (enrichment queue)
    body += `## Needs Summary (enrichment queue)\n\n`;
    body += "```dataview\n";
    body += "TABLE author AS \"Author\"\n";
    body += 'FROM ""\n';
    body += 'WHERE record_type = "bookmark" AND llm_summary = null\n';
    body += "SORT saved_at DESC\n";
    body += "LIMIT 20\n";
    body += "```\n\n";

    // Static fallback
    body += `---\n\n`;
    body += `### Navigation\n\n`;
    body += `- [[Farcaster|Source: Farcaster]]\n`;
    body += `- Authors: ${Object.keys(byAuthor).slice(0, 10).map((a) => `[[${a}]]`).join(", ")}${authorCount > 10 ? ", ..." : ""}\n`;
    body += `- Topics: ${Object.keys(topicHits).map((t) => `[[${CANONICAL_TOPICS[t]?.label || t}]]`).join(", ")}\n`;

    files["00 Dashboards/Farcaster Bookmarks.md"] = body;
  }

  // Build ZIP and download
  const zip = buildZip(files);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(zip, `farcaster-bookmarks-vault-${date}.zip`, "application/zip");
}

// ── Topic detection (keyword-based, deterministic) ────────────

function detectTopics(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];
  for (const [key, topic] of Object.entries(CANONICAL_TOPICS)) {
    for (const kw of topic.keywords) {
      if (lower.includes(kw)) {
        found.push(key);
        break;
      }
    }
  }
  return found;
}

// ── YAML frontmatter ──────────────────────────────────────────

function yamlBlock(obj) {
  let yaml = "---\n";
  for (const [k, v] of Object.entries(obj)) {
    yaml += yamlField(k, v);
  }
  yaml += "---\n";
  return yaml;
}

function yamlField(key, val) {
  if (val === null || val === undefined) return `${key}:\n`;
  if (Array.isArray(val)) {
    if (val.length === 0) return `${key}: []\n`;
    // Wikilink arrays always use block style (never inline strings)
    const hasWikilinks = val.some((v) => typeof v === "string" && v.startsWith("[["));
    if (!hasWikilinks && val.length <= 4 && val.every((v) => typeof v === "string" && v.length < 40)) {
      return `${key}: [${val.map(yamlScalar).join(", ")}]\n`;
    }
    let out = `${key}:\n`;
    for (const item of val) out += `  - ${yamlScalar(item)}\n`;
    return out;
  }
  if (typeof val === "number" || typeof val === "boolean") return `${key}: ${val}\n`;
  return `${key}: ${yamlScalar(val)}\n`;
}

function yamlScalar(val) {
  if (val === null || val === undefined) return "null";
  const s = String(val);
  // Wikilinks must stay unquoted so Obsidian/Dataview recognise them
  if (s.startsWith("[[") && s.endsWith("]]")) return s;
  // Other strings with special chars get quoted
  if (/[:#{}[\],&*?|>!%@`]/.test(s) || s.includes('"')) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ── Extract helpers ───────────────────────────────────────────

function obExtractText(b) {
  const d = b.castData;
  if (!d) return "";
  return d.text || d.body?.text || d.cast?.text || d.result?.cast?.text || "";
}

function obExtractAuthor(b) {
  const d = b.castData;
  if (!d) return "Unknown";
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  return a.displayName || a.display_name || a.username || (a.fid ? `fid-${a.fid}` : "Unknown");
}

function obExtractUsername(b) {
  const d = b.castData;
  if (!d) return null;
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  return a.username || null;
}

function obExtractFid(b) {
  const d = b.castData;
  if (!d) return null;
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  return a.fid || d.authorFid || null;
}

function obExtractPublished(b) {
  const d = b.castData;
  if (!d) return null;
  return d.timestamp || d.publishedAt || d.published_at || null;
}

function obExtractCastUrl(b) {
  const d = b.castData;
  if (!d) return null;
  const a = d.author || d.user || d.cast?.author || d.result?.cast?.author || {};
  const username = a.username;
  const hash = b.castHash || d.hash || d.cast?.hash;
  if (username && hash) return `https://farcaster.xyz/${username}/${hash.slice(0, 10)}`;
  return null;
}

function obExtractEmbeds(b) {
  const d = b.castData;
  if (!d) return [];
  let raw = d.embeds || d.body?.embeds || [];
  if (!Array.isArray(raw)) {
    raw = typeof raw === "object" ? Object.values(raw) : [];
  }
  return raw.map((e) => {
    if (typeof e === "string") return { type: "link", url: e };
    const url = e.url || e.uri || e.openGraph?.url || null;
    let type = e.type || "link";
    if (!e.type && url) {
      if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) type = "image";
      else if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) type = "video";
    }
    return { type, url };
  }).filter((e) => e.url);
}

function normalizeTimestamp(val) {
  if (!val) return val;
  // Already an ISO string
  if (typeof val === "string" && /\d{4}-\d{2}-\d{2}/.test(val)) return val;
  // Epoch ms (number or numeric string)
  const num = Number(val);
  if (!isNaN(num) && num > 1e12) return new Date(num).toISOString();
  // Epoch seconds
  if (!isNaN(num) && num > 1e9) return new Date(num * 1000).toISOString();
  return String(val);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
}

// ── Minimal ZIP builder (STORE, no compression) ───────────────

function buildZip(files) {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, content]) => ({
    name: encoder.encode(name),
    data: encoder.encode(content),
  }));

  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const header = new Uint8Array(30 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc32(entry.data), true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, entry.name.length, true);
    view.setUint16(28, 0, true);
    header.set(entry.name, 30);

    const cdir = new Uint8Array(46 + entry.name.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc32(entry.data), true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdir.set(entry.name, 46);
    central.push(cdir);

    parts.push(header, entry.data);
    offset += header.length + entry.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { parts.push(c); centralSize += c.length; }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);

  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { result.set(p, pos); pos += p.length; }
  return result;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function downloadBlob(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
