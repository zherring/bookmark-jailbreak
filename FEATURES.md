# Features & Roadmap

## Shipped

### v0.1.0 — One-time export
- Export all Farcaster bookmarks as JSON via internal API
- Auth header capture via fetch interception
- Pagination with cursor support
- Normalized schema with cast hash, author, text, embeds, timestamps

### v0.2.0 — Continuous capture
- Live bookmark detection: intercepts POST/PUT/DELETE to bookmark endpoints
- Persistent storage via chrome.storage.local
- Background service worker for bookmark management
- Popup shows stored bookmark count and sync status
- Export from storage (works offline / without being on Farcaster)
- Bulk sync from API into local storage

## Next up

### Export formats
- **Markdown (Obsidian-friendly)**: One `.md` file per cast with YAML frontmatter (author, date, hash, tags). Wikilinks between related casts. Downloadable as a zip.
- **CSV**: Flat table for spreadsheet workflows
- **JSON**: Already done — keep as raw/debug format
- **Litewrite-compatible**: Format TBD — structured for use as "inspiration" feed in Litewrite multi-platform posting tool

### Knowledge graph / theme extraction
- Cluster bookmarks by topic, author, channel, or embedded links
- Generate an Obsidian MOC (Map of Content) or tag taxonomy
- Likely needs an LLM pass over bookmark text — could use Claude API
- Surface patterns: "you bookmark a lot about X" / "these 5 casts are all about Y"
- Could generate a daily/weekly digest of bookmark themes

### Continuous sync improvements
- Badge icon showing new bookmark count since last export
- Optional auto-export on interval (e.g., nightly markdown sync to a folder)
- Detect unbookmark actions and update storage
- Sync state indicator in popup (last capture time, queue size)

### Other ideas
- Multi-source support: extend the SavedSourceAdapter pattern to other platforms (Twitter/X likes, Are.na saves, Pocket, etc.)
- Bookmark search within the popup
- Tagging / manual categorization layer on top of raw bookmarks
