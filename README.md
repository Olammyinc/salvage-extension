# Salvage

A browser extension that finds the duplicates, dead links, and forgotten folders hiding in your bookmark library. Nothing gets deleted without your say-so, and everything is recoverable.

## What it does

Salvage scans your entire bookmark tree and builds a Library Report: total bookmarks, how old your library is, exact duplicate URLs, empty folders, folders with the same name, bookmarks with no recorded opening, and the oldest bookmark you've got.

It also checks dead links if you opt in, and lets you clean up by moving duplicates and dead bookmarks to a Salvage Trash folder instead of deleting them.

**Version 0.2.1** includes:

- Full bookmark tree scan with resumable chunks that survive browser restarts
- Backup export of your entire bookmark library to JSON
- Exact duplicate detection using normalized URL matching
- Empty folder and same-name merge candidate detection
- Opt-in dead-link checking with three-state results: reachable, unreachable, or could not check
- Salvage Trash: move-based cleanup with 30-day retention and undo
- Categorization by domain and keyword rules

## Privacy

No AI. No API keys. No search. No payments. The only network requests happen when you opt in to check dead links, and even then the extension asks for permission first. The scan itself never fetches any of your bookmarked pages.

## Install

### Chrome, Edge, or Brave

1. Open the extensions page: `chrome://extensions`, `edge://extensions`, or `brave://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder (the one containing `manifest.json`).
4. Pin the extension from the toolbar.
5. Click the icon and hit **Scan now**.

### Firefox (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and pick any file inside `firefox/` (like `manifest.json`).
3. The add-on loads for this session only. It disappears when Firefox restarts -- that's normal temporary add-on behavior.
4. Click the extension icon and hit **Scan now**.

Chrome/Edge/Brave load the `extension/` package. Firefox loads the `firefox/` package. The two packages are separate static copies because their MV3 background manifest keys differ: Chromium uses `background.service_worker` while Firefox uses `background.scripts` to load classic scripts in order. Both packages share identical runtime code; only the manifest `background` key differs.

## How the scan handles browser restarts

Chrome kills idle service workers after about 30 seconds. Salvage handles this by:

- Storing scan progress in `chrome.storage` after every chunk (roughly 75 links)
- Using `chrome.alarms` to schedule the next chunk, never `setTimeout` or `setInterval`
- Resuming from the checkpoint when the worker wakes back up
- Never holding scan state in worker memory

The popup reads progress from storage, not from the worker, so it always shows accurate status even if the worker was killed between updates.

## Run the tests

Requires Node.js (any recent LTS).

```
node extension/test/run-tests.js 3000 42
```

The suite covers URL normalization, rules categorization, report metrics, duplicate detection, empty folder and same-name merge detection, backup export, link checking, popup UI, Firefox compatibility, and a full integration harness that simulates worker termination and resumption against a 3,000+ bookmark tree.

## Current limitations

- **Open history is sparse.** Chrome only records `dateLastUsed` from around version 114-117, and only for bookmarks opened through the bookmark UI. Salvage reports "no recorded opening" rather than "never opened," and shows the coverage fraction so you can see how much data Chrome actually has.
- **Rules coverage is small.** The categorization map is a representative set of domains and keywords. It works, but a production release would need a larger map.
- **No real-Chrome performance numbers.** The test suite uses mocked Chrome APIs. Real-browser scan timing has not been measured yet.
- **Firefox is temporary only.** The extension carries no AMO gecko ID, so it cannot be installed as a signed persistent add-on. It works as a temporary add-on for testing.
- **No backup import.** The extension exports your bookmarks to JSON, but does not import them back. Use your browser's built-in bookmark import for that.
