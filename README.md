# Farcaster Bookmarks Exporter

Chrome extension (Manifest V3) that exports your Farcaster bookmarks as JSON.

## How it works

1. Piggybacks on your existing authenticated session on farcaster.xyz
2. Calls the same internal `bookmarked-casts` API the web app uses
3. Paginates through all results, deduplicates, normalizes, and downloads as JSON

## Setup

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select this directory
4. Navigate to https://farcaster.xyz/~/bookmarks (make sure you're logged in)
5. Click the extension icon and press **Export Bookmarks**

## Updating the endpoint

If the API path changes, edit the `ENDPOINT_BASE` constant at the top of `farcaster.js`.

## Output

Downloads a file like `farcaster-bookmarks-2026-03-15.json` with the schema documented in the spec.

## Known limitations

- Requires an active logged-in session on farcaster.xyz
- The internal API is undocumented and may change without notice
- Embed type detection is heuristic-based
- No DOM fallback implemented yet (placeholder for future)
- `saved_at` may be null if the API doesn't return bookmark timestamps
- Icon files are placeholders — replace with real icons for distribution
