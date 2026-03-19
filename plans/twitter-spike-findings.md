# Twitter Spike Findings

## Date

2026-03-19

## What This Spike Needed To Answer

1. Is the current Twitter/X bookmarks feed still exposed through a GraphQL `Bookmarks` operation?
2. Does the response still look like `bookmark_timeline_v2.timeline.instructions`?
3. Does the web app deliver bookmark timeline data through XHR, fetch, or both?
4. Do captured requests include enough variables/cursor metadata to attempt replayed pagination later?

## What Is Already Confirmed

From the current `twitter-web-exporter` upstream codebase:

- upstream `main` was updated recently: commit `ef83e68` on 2026-03-07
- the bookmark module still matches `/graphql/.../Bookmarks`
- the bookmark parser still reads `data.bookmark_timeline_v2.timeline.instructions`
- the project still describes itself as a capture-only exporter that depends on the web app loading data and explicitly says it does not send its own API requests

Implication:

- the upstream extraction approach still looks current enough to treat as a viable reference
- manual-scroll capture remains the safest default assumption for v1 sync until we prove replay works

## What Was Added In This Repo

### Live probe

A lightweight Twitter/X spike probe is now installed by the extension on:

- `https://x.com/*`
- `https://twitter.com/*`

Files:

- `twitter-spike.js`
- `popup.js`
- `popup.html`
- `manifest.json`

### What the probe captures

For `.../i/api/graphql/.../Bookmarks` responses, the probe records:

- transport: `xhr` or `fetch`
- operation name
- HTTP status
- whether `bookmark_timeline_v2` exists
- instruction types present
- number of `TimelineAddEntries` entries
- sample tweet IDs
- whether request `variables`, `features`, and `fieldToggles` were present
- whether a request cursor was present

The probe stores only lightweight diagnostics on `window.__TWITTER_BOOKMARK_SPIKE__`.

## How To Use The Probe

1. Reload the extension in Chrome.
2. Open `x.com/i/bookmarks` or `twitter.com/i/bookmarks`.
3. Scroll enough to trigger bookmark timeline network requests.
4. Open the extension popup.
5. On Twitter/X pages, the popup now shows `Twitter Spike`.
6. Click `Read Spike`.

Expected outcomes:

- if capture is working, the popup will show transport, operation, status, timeline presence, instruction types, entry count, and sample tweet IDs
- if nothing has been captured yet, the popup will say to open the bookmarks page and scroll

## Decision Gate After Manual Run

After one real run against a logged-in bookmarks page, we should be able to classify the implementation path:

### Path A: replay looks viable

Choose this if the probe shows:

- stable `Bookmarks` operation matches
- request variables/features are consistently present
- cursors are visible in request metadata
- payload shape matches `bookmark_timeline_v2.timeline.instructions`

Then the next step is a replay-capable Twitter adapter prototype.

### Path B: replay is too brittle

Choose this if the probe shows:

- missing or unstable request metadata
- transport ambiguity that makes replay hard
- payload instability

Then the next step is a manual-scroll sync adapter that imports all captured bookmark responses without trying to paginate itself.

## Current Recommendation

Until we have a live probe result from a real Twitter/X session, keep the milestone outcome as:

- upstream extractor shape: confirmed
- capture-only/manual-scroll default: confirmed
- replay viability: not yet confirmed

That means the spike is partially complete in code, but still needs one manual run in-browser to resolve the final decision point.
