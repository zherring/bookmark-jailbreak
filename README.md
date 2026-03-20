# Bookmark Jailbreak

A Chrome extension that captures and archives your bookmarks from **Farcaster** and **Twitter/X**, with support for live capture, bulk export, and multiple output formats (JSON, Markdown, Obsidian).

## Features

- **Live capture** — automatically detects when you bookmark or unbookmark a post
- **Bulk export** — paginate through all your bookmarks via API (Farcaster) or scroll capture (Twitter)
- **Unified archive** — browse, search, and filter bookmarks from both platforms in a single side panel
- **Search operators** — free text, `from:username`, `topic:ai`
- **Multiple export formats** — JSON, Markdown, and Obsidian vault (ZIP with Dataview-compatible frontmatter)
- **Report view** — analytics dashboard with per-author and per-topic breakdowns
- **Zero dependencies** — pure vanilla JS, no build step required

## Install

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `budapest` directory
5. (Optional) Pin the extension to your toolbar for quick access

## Usage

### Live Capture

Just browse normally. When you bookmark a post on Farcaster or Twitter/X, the extension captures it automatically and shows a toast notification. Open the side panel to see your archive update in real time.

### Bulk Sync — Farcaster

1. Navigate to [farcaster.xyz/~/bookmarks](https://farcaster.xyz/~/bookmarks)
2. Click the extension icon to open the popup
3. Click **Export Bookmarks**
4. The extension discovers your auth headers and paginates through all your bookmarks

### Bulk Sync — Twitter/X

1. Navigate to [x.com/i/bookmarks](https://x.com/i/bookmarks)
2. **Scroll through your bookmarks page** — this loads them into the extension's cache
3. Click the extension icon and click **Sync Bookmarks**

### Side Panel (Archive View)

Click **Open Archive** in the popup (or use Chrome's side panel menu) to access the full archive:

- **Search** bookmarks by text, author (`from:name`), or topic (`topic:crypto`)
- **Filter** by platform (All / Farcaster / Twitter)
- **Sort** by saved date or posted date
- **Export** as JSON or Markdown
- **Switch views** between a bookmark list and an analytics report
- **Delete** individual bookmarks with the **x** button

### Obsidian Export

Download the JSON export from the side panel, then use the Obsidian export feature to generate a ZIP file with:

- One note per bookmark with YAML frontmatter
- Dataview-compatible metadata (`record_type`, author, topic, platform)
- Organized for use with Obsidian's Dataview plugin

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab to detect bookmarks |
| `scripting` | Inject content scripts for live capture |
| `storage` | Persist your bookmark archive locally |
| `sidePanel` | Display the archive in Chrome's side panel |
| `webRequest` | Backup network detection for bookmark actions |
| Host access to `farcaster.xyz`, `x.com`, `twitter.com` | Capture bookmarks from these platforms |

All data stays in your browser's local storage. Nothing is sent to external servers.

## Project Structure

```
budapest/
  manifest.json          # Chrome extension manifest (MV3)
  background.js          # Service worker — storage, message routing, deduplication
  popup.html/js          # Toolbar popup UI
  sidepanel.html/js      # Side panel — main archive view
  intercept.js           # Farcaster fetch interception (MAIN world)
  content.js             # Farcaster DOM observation (ISOLATED world)
  farcaster.js           # Farcaster API adapter
  twitter-spike.js       # Twitter/X network probe (MAIN world)
  twitter-content.js     # Twitter/X message relay (ISOLATED world)
  twitter.js             # Twitter adapter
  utils.js               # Shared normalization and search utilities
  obsidian-export.js     # Obsidian vault ZIP generator
```

## Development

Edit files in place and click **Reload** on `chrome://extensions/` to pick up changes. Content scripts require a page refresh to reconnect.

## Disclaimer

This extension is a personal tool shared informally — it is **not** distributed through the Chrome Web Store or any official channel.

**How it works:** Bookmark Jailbreak reads data from pages you are already viewing in your own authenticated browser session. It does not make independent API requests, does not bypass authentication, and does not send any data to external servers. All captured bookmarks are stored locally in your browser's `chrome.storage.local`.

**Platform terms of service:** Twitter/X and Farcaster may restrict automated access to their platforms in their Terms of Service. This extension passively reads data that your browser has already loaded — it does not crawl, bulk-scrape, or redistribute content. However, use of this extension may still fall outside the intended scope of those platforms' terms. By using this extension, **you accept full responsibility** for ensuring your use complies with the terms of service of any platform you use it with.

**No warranty:** This software is provided "as is", without warranty of any kind. The authors are not liable for any claim, damages, or other liability arising from its use. Platforms may change their APIs or terms at any time, which could break functionality or affect compliance.

**Not for commercial use.** This tool is intended for personal archival only. Do not use it to collect, resell, or publicly redistribute other people's content.
