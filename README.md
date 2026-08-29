# Salvage

A browser extension that helps you clean up your bookmarks. It runs entirely on your machine and does not send your data anywhere.

## What it does

- Scans your local bookmarks for duplicates and cleanup opportunities
- Exports your bookmarks as a backup file you can restore later
- Optionally checks for dead links (disabled by default, you turn it on)
- Moves removed bookmarks to a trash folder kept for 30 days so you can undo mistakes

## How it works

Salvage is a Manifest V3 extension. It reads your browser bookmarks using the standard Bookmarks API, analyzes them locally, and presents results in a popup UI. No account, API key, or internet connection is required for core features.

## Supported browsers

- Chrome (desktop) -- Manifest V3 service worker
- Edge (desktop) -- Manifest V3 service worker
- Brave (desktop) -- Manifest V3 service worker (same Chromium engine)
- Firefox (desktop, 121+) -- Manifest V3 event page (Firefox ignores `service_worker` and uses `background.scripts`)

The manifest includes both `background.scripts` (used by Firefox) and `background.service_worker` (used by Chrome/Edge/Brave). A single manifest works in all supported browsers without a separate build step.

Firefox 121+ is required because earlier versions refused to start the background page when `service_worker` was present. From 121 onward, Firefox ignores the `service_worker` key and runs the listed `scripts` as an event page.

Android and iPad versions of Chrome do not support browser extensions. Firefox for Android supports extensions but has a limited add-on collection; this extension is not currently listed there.

## Installation from source

### Chrome / Edge / Brave

1. Download or clone this repository.
2. Open Chrome or Edge and navigate to `chrome://extensions` (or `edge://extensions` in Edge).
3. Enable "Developer mode" using the toggle in the top-right corner.
4. Click "Load unpacked" and select the folder containing this repository.
5. The Salvage icon will appear in your toolbar. Click it to open the popup.

### Firefox

1. Download or clone this repository.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on" and select the `manifest.json` file in this repository.
4. The Salvage icon will appear in your toolbar. Click it to open the popup.

Note: Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension must be signed through [addons.mozilla.org](https://addons.mozilla.org) (AMO).

## Running tests

Requires Node.js.

```
node test/run-tests.js 3000 42
```

The first argument is a timeout in milliseconds. The second is a random seed for test ordering.

## Project structure

- `manifest.json` -- Extension manifest (Manifest V3)
- `background/` -- Service worker and background logic
- `ui/` -- Popup HTML, CSS, and JavaScript
- `shared/` -- Code shared between background and UI
- `assets/` -- Icons and static files
- `_locales/` -- Localization strings
- `test/` -- Test suite
- `tools/` -- Development and build utilities
- `fixture.html` -- Test fixture page

## License

See the repository for license terms.
