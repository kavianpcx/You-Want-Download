# Contributing to You Want Download

This is an MIT-licensed, free Windows download manager. All features must be implemented and verified before being advertised as complete.

## Structure

- `internal/downloader/engine.go`: HTTP(S) engine, persistence, safe segmented downloads, download queue and retries.
- `internal/downloader/routes.go`, `routes_windows.go`, `routes_other.go`: network discovery and per-socket interface selection. Windows uses `IP_UNICAST_IF`.
- `internal/downloader/*_test.go`: local HTTP integration tests, segment-route simulation, file checks, and settings persistence.
- `main.go`, `app.go`: Wails v2 Windows app with native OS chrome and clipboard bridge.
- `frontend/dist/`: static, small HTML/CSS/JavaScript interface; no UI framework.
- `tests/ui_smoke.py`: Chromium interaction tests using sample files and a mocked OS bridge.
- `.github/workflows/release.yml`: Linux race/UI tests, Windows tests, Wails build, NSIS installer/portable release.

## Local checks

```bash
go test -race -count=1 ./internal/downloader
node --check frontend/dist/app.js
python tests/ui_smoke.py  # pip install playwright; python -m playwright install chromium
```

Add tests for resume from partial bytes, ETag changes, no-range fallback, retries, folder selection, route failures, and especially corrupted-range handling. Keep clipboard reads user-initiated. The multiple-network feature must never silently claim packet-level bonding or 2× speed.

The Wails window uses the **native** frame and Windows title-bar buttons; do not replace them with unsafe custom controls. Test the NSIS install directory picker, executable icon, minimize/maximize/close, and dual-WAN behavior on actual Windows hardware when available. The test screenshot is real rendered HTML/CSS with clearly marked **sample downloads**, not a native window screenshot. Preserve user files when removing a download from the queue.

## Roadmap

Automatic verified differential updater with rollback, real dual-ISP performance benchmarks on Windows, category-based folder rules, optional extension integration, speed caps, advanced queue schedules, and Persian localization. Please avoid claiming these features exist until tested.
