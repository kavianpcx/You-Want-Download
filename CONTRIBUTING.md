# Contributing to You Want Download

Thank you for helping build a safe, reliable open-source download manager.

## Setup and tests

Use Node.js 22+, run `npm install`, then `npm run check && npm test`. Tests use a loopback HTTP fixture, so no public download service is needed. Run `npm start` to inspect the desktop interface. Windows releases are assembled in GitHub Actions using electron-builder and NSIS; the packaging output cannot be verified with Node-only tests.

## Before requesting a feature

Correctness comes before reported download speed. A server is allowed to ignore `Range`, change ETags, truncate responses, redirect, or terminate a connection. Every new downloader feature needs a fixture test covering data correctness and a safe failure path. Do not silently skip checksum/size checks or overwrite existing files.

## Pull requests

- Keep the Electron renderer sandboxed and use explicit IPC channels in `app/preload.cjs`.
- Never put unsanitized filenames or URLs into HTML markup.
- Avoid adding telemetry, advertising, paid features or bypasses for DRM.
- Add a test for fixes to pause/resume, retries, or file assembly.
- Describe Windows smoke-test results separately from Linux/Node tests.
- Use semantic versioning for releases and note upgrade compatibility.

## Planned work

1. Windows install/launch and update tests against real signed release pairs.
2. Stronger resume validators and optional SHA-256 verification.
3. Named queues and independent queue policies, host-aware throttling and speed caps.
4. Browser extension interoperability, accessibility, Persian localization and RTL layout.
5. Optional dedicated torrent component with a reviewed dependency and clear licensing.

## Licensing

By contributing, you agree to license your contribution under the repository's MIT license. Do not copy IDM or FDM proprietary code or assets.
