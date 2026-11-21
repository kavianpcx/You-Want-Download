# Contributing to You Want Download

You Want Download is an open-source Windows download manager under the MIT License. Issues and pull requests are welcome.

## Architecture

- `internal/downloader/engine.go`: standard-library-only Go HTTP(S) download engine, persistent queue, segmented transfers, retries and safe assembly.
- `internal/downloader/engine_test.go`: deterministic local HTTP tests; no third-party service or live internet required.
- `main.go`, `app.go`: Wails v2 desktop shell, Go/JS bridge and Windows integration.
- `frontend/dist/`: compact dependency-free UI with consistent inline SVG icons, dialogs, filters and per-file connections.
- `tests/ui_smoke.py`: Chromium-based UI interaction tests using sample jobs, never claimed as real transfers.
- `.github/workflows/release.yml`: Linux Go race tests, Windows engine tests, Wails packaging and release gating.

## Before sending a PR

Run `go test -race -count=1 ./internal/downloader` and `node --check frontend/dist/app.js`; if you modify UI, run `python tests/ui_smoke.py` with Playwright/Chromium installed. Do not use `preview` sample downloads in production. For Windows changes, verify the Wails build and installer in Windows and confirm that a portable launch needs no installation.

Please test resumability on byte-range servers, no-range fallback, redirects, changing validators, interrupted transfers, filename collisions and download history after app exit. Preserve user files; removing a task must never delete the completed file without a separate explicit action. Add test coverage when fixing a bug. Keep UI interactions keyboard-accessible and error messages understandable.

## Roadmap

- Windows GUI automation on a Windows runner, live installer/uninstaller and Windows 10 compatibility tests.
- Verified and signed differential updater with rollback, safe patch manifests, and repeated release-to-release tests.
- Global speed limits, richer queues, proxy settings, drag/drop, tray controls, multi-language UI including Persian RTL.
- Browser extension protocol registration and interception with explicit permissions and security review.
- Torrent, media handling and file checksum verification as separate audited features.

Please don't advertise unimplemented features as working. Package sizes and download speeds should be measured and reported instead of guessed.
