# Twitter Sync Plan

## Goal

Expand this extension from a Farcaster-only bookmark archiver into a multi-platform bookmark tool that can also ingest Twitter/X bookmarks, while preserving the current strengths:

- lightweight MV3 extension architecture
- live capture into `chrome.storage.local`
- sidepanel as the primary archive UI
- JSON and Obsidian export from a normalized record shape

The immediate target should be **Twitter bookmark sync first**, not a full port of `twitter-web-exporter`.

## What We Have Today

Current extension shape:

- `intercept.js` patches `fetch` in the page context on `farcaster.xyz`
- `content.js` handles DOM-driven add/remove detection and asks the main-world script for cached cast data
- `background.js` stores normalized bookmark records in `chrome.storage.local`
- `sidepanel.js` reads a single bookmark store and renders/searches/exports it
- `farcaster.js` provides a sync adapter that can replay the Farcaster bookmarks API once auth headers have been observed

This is already close to a platform-adapter model, but the implementation is still Farcaster-specific:

- manifest permissions only allow Farcaster
- storage keys are `fc_*`
- message names are `FC_*`
- UI copy assumes one source
- record helpers assume Farcaster fields like `castHash`, `fid`, and cast URLs

## What To Reuse From `twitter-web-exporter`

Relevant upstream patterns:

- Intercept network traffic in the **page context**, not the extension/content-script context
- Match Twitter GraphQL requests by **operation name** (`/graphql/.../Bookmarks`), not hard-coded query hashes
- Parse bookmark payloads from `bookmark_timeline_v2.timeline.instructions`
- Extract tweets from `TimelineAddEntries` entries and sort by `sortIndex`
- Treat Twitter as a **capture-what-the-web-app-loaded** system unless request replay is proven reliable

Relevant upstream files:

- `src/modules/bookmarks/api.ts`
- `src/core/extensions/manager.ts`
- `src/utils/api.ts`

What not to import wholesale:

- the Preact/Tailwind control panel
- Dexie capture database
- the extension manager/module framework
- exporter UI and generic multi-feature surface area

Those pieces solve a much broader product than this repo currently needs.

## Recommendation

Use the upstream project as a **parsing reference and source of extraction logic**, but implement Twitter support as a new adapter inside this extension.

That means:

1. Keep the current MV3 extension and sidepanel model.
2. Add a Twitter page-context interceptor plus a Twitter sync adapter.
3. Introduce a platform-neutral bookmark record shape in storage.
4. Update the sidepanel/exporters to render mixed-source records.

This is lower-risk than embedding the userscript, and it keeps the codebase coherent.

## Proposed Architecture

### 1. Introduce a platform-neutral domain model

Add a canonical record shape like:

```js
{
  id,
  platform,           // "farcaster" | "twitter"
  item_id,            // cast hash or tweet rest_id
  url,
  author: {
    id,
    username,
    display_name
  },
  text,
  media,
  saved_at,
  published_at,
  captured_via,       // "live" | "sync"
  raw
}
```

Notes:

- Keep `raw` so export fidelity is not lost.
- Use a composite stable key such as `${platform}:${item_id}`.
- Farcaster records can be backfilled into this shape lazily during read or migrated in place.

### 2. Formalize adapters

The repo already has an implicit Farcaster adapter in `farcaster.js`. Make that explicit:

- `platforms/farcaster/*.js`
- `platforms/twitter/*.js`

Each adapter should own:

- `canHandle(url)`
- `isBookmarksPage(url)`
- `exportAll(tabId)` or `captureVisible(tabId)`
- `normalize(raw)`
- optional live add/remove capture hooks

This keeps `sidepanel.js`, `popup.js`, and `background.js` from growing platform branches everywhere.

### 3. Add a Twitter main-world interceptor

Create a page-context script for `x.com` and `twitter.com` that:

- patches both `XMLHttpRequest` and `fetch`
- watches for `/i/api/graphql/.../Bookmarks`
- clones successful responses and parses bookmark timeline entries
- caches tweet objects by `rest_id`
- exposes a small bridge object on `window` for sync/export, similar to `window.__FC_EXPORT__`

Why both XHR and fetch:

- upstream relies on XHR interception
- the current extension already has a fetch-patching pattern
- Twitter may shift transport details again, so dual coverage is worth the small complexity

### 4. Start with sync, then add live add/remove

Phase the Twitter work:

- Phase 1: capture and sync bookmarks visible/loaded on the bookmarks page
- Phase 2: detect bookmark add/remove actions from tweet menus and keep the archive live

Sync-only is the fastest way to validate extraction and normalization without coupling to brittle menu DOM immediately.

## Recommended Implementation Phases

### Phase 0: Spike and verify assumptions

Before broad refactors, build a short proof-of-concept that answers:

- Is the bookmarks timeline still exposed as `/graphql/.../Bookmarks` on `x.com` and/or `twitter.com`?
- Is the response shape still compatible with upstream `bookmark_timeline_v2.timeline.instructions` extraction?
- Are bookmark pages loaded via XHR, fetch, or both in the current web app?
- Can captured request metadata be replayed safely from the extension, or should sync depend on user scrolling/loading?

Deliverable:

- a local spike branch or notes confirming the current transport and payload shape

Exit criteria:

- we know whether automated pagination is viable or whether v1 should be "capture all loaded bookmarks"

### Phase 1: Platform-neutral storage refactor

Refactor `background.js`, `sidepanel.js`, `utils.js`, and `obsidian-export.js` to stop assuming Farcaster-only fields.

Concrete changes:

- rename `fc_bookmarks` to a neutral key like `bookmarks_v2`
- rename `FC_*` runtime messages to neutral names
- support records keyed by `${platform}:${item_id}`
- update list rendering helpers to branch on `platform`
- keep Farcaster behavior unchanged

This is the right first real change because Twitter support will otherwise duplicate every path.

### Phase 2: Twitter sync adapter

Add:

- manifest host permissions for `https://x.com/*` and `https://twitter.com/*`
- content/main-world scripts for Twitter
- `twitter.js` adapter with `canHandle`, `isBookmarksPage`, and `exportAll`

Recommended v1 sync contract:

- user opens the Twitter bookmarks page
- extension captures loaded bookmark GraphQL responses
- user clicks Sync All
- adapter returns all unique tweet objects seen so far
- background normalizes and stores them

If replay/pagination is proven viable in Phase 0, extend `exportAll` to continue requesting additional pages using the captured variables/cursors. If not, ship manual-scroll sync first.

### Phase 3: Twitter live bookmark capture

After sync works, add live add/remove support.

Likely strategies:

- network-level detection of bookmark mutation requests/responses
- DOM detection of "Bookmark"/"Remove bookmark" menu actions as a backup

Preferred order:

- first detect successful bookmark/unbookmark network mutations
- use cached tweet data from the timeline interceptor for enrichment
- fall back to DOM lookup only if mutation payloads lack tweet identifiers

This mirrors the Farcaster pattern: network + DOM, with deduplication in the background.

### Phase 4: Unified export and Obsidian output

Update exporters so Twitter records round-trip cleanly.

JSON export:

- include `platform` at the item and payload level
- preserve Twitter-native IDs and URLs

Obsidian export:

- generalize source pages from `Farcaster.md` to per-platform sources
- generate Twitter bookmark note filenames from stable tweet IDs
- update topic extraction helpers to use generic text/media fields

## Parsing Strategy For Twitter

Port only the minimum upstream extraction helpers needed:

- timeline instruction traversal
- sortIndex ordering
- tweet extraction from item content
- tweet/user/media normalization

Do not port the full type system. This repo is plain JavaScript, so the practical move is:

- copy the extraction logic conceptually
- implement a focused JS parser for bookmark timeline entries
- keep it isolated in a single adapter file with fixture-based tests if a test harness is added

## Risks

### 1. Twitter transport instability

Twitter/X changes internal GraphQL query hashes, request features, and payload structure regularly.

Mitigation:

- match on operation names, not query hashes
- keep extraction logic narrow and defensive
- isolate Twitter parsing behind one adapter boundary

### 2. Sync semantics may differ from Farcaster

Farcaster sync currently does active pagination once headers are captured. Twitter may not allow that cleanly without reproducing request variables and cursors exactly.

Mitigation:

- validate replay first
- plan for a manual-scroll v1 that still provides value

### 3. Current codebase is more platform-specific than comments suggest

The comments say "platform-agnostic", but the storage, messages, naming, and UI are still Farcaster-coded.

Mitigation:

- do the storage/message normalization before adding Twitter-specific branches

### 4. Sidepanel complexity can sprawl quickly

Mixed-source rendering can become messy if every helper switches on platform ad hoc.

Mitigation:

- normalize records early
- keep platform-specific display helpers near the adapter

## Suggested File-Level Plan

1. Add `plans/twitter-sync-plan.md` and keep it updated as assumptions are verified.
2. Refactor `background.js` to neutral storage/message names and composite bookmark IDs.
3. Move Farcaster-specific sync logic into a dedicated platform folder.
4. Add a Twitter interceptor pair and a `twitter.js` adapter.
5. Update `manifest.json` for Twitter hosts and scripts.
6. Generalize `sidepanel.js`, `utils.js`, and `obsidian-export.js` to a mixed-platform model.
7. Add a debug/diagnostics surface for Twitter capture state similar to the Farcaster popup diagnostics.

## Validation Plan

Minimum manual test matrix:

- Farcaster live bookmark add/remove still works
- Farcaster Sync All still imports historical bookmarks
- Twitter bookmarks page captures loaded tweets
- Twitter Sync All deduplicates across repeated loads
- mixed Farcaster + Twitter archives render and search correctly
- JSON export includes both platforms cleanly
- Obsidian export generates stable files for both platforms

## Open Questions

- Do we want one mixed archive UI or a per-platform filter/toggle by default?
- Is `twitter.com` still required, or can we target `x.com` only for v1?
- Do we want Twitter sync-only first, or is live add/remove required for launch?
- Is backwards migration of existing `fc_*` storage acceptable, or should we support read-through compatibility for one version?

## Bottom Line

The right path is to **port the Twitter bookmark extraction ideas, not the whole upstream app**.

The upstream repo proves the hard part: Twitter bookmarks can be harvested from web-app GraphQL responses. This extension already has a simpler and better-fitting architecture for capture, storage, sidepanel browsing, and export. The main work is:

- neutralize the Farcaster-specific core
- add a Twitter adapter/interceptor
- decide whether Twitter sync is replay-based or manual-scroll-based after a short spike
