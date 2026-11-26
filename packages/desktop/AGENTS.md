# @breatic/desktop rules

The Electron client for macOS, Windows and Linux. Its windows show the web app of the one server its build names; how it fits together is in [docs/ARCHITECTURE.md#desktop-client](../../docs/ARCHITECTURE.md#desktop-client).

## The brand comes from the build

**Client code never writes the official product name, its scheme or its server; it reads `BRAND` (`src/main/brand.ts`), and every string that names the app takes a `{product}` parameter.** A partner build must show the partner's name everywhere. `src/main/__tests__/no-fixed-brand.test.ts` scans the sources and lists what is allowed.

- **A new per-brand name (a path, a file name, a package or executable name) is derived from the brand (`id` or `productName`) in `brand.mjs`, never written as a constant.** Two brands installed on one machine must not share a data directory, a launcher entry, a deb package or a scheme.

## Process boundaries

- **Every window keeps `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true`; the preload exposes only `window.breaticDesktop`, typed in `@breatic/shared`'s `desktop-bridge.ts`.** The windows run a server's pages, not ours.
- **Every `ipcMain.handle` checks `event.senderFrame` before acting: the app's calls only from the server origin, `unreachable:retry` only from a main frame showing that window's error entry.** Never derive an origin from `senderFrame.url`, and never take a URL from the page.
- **The preload and the main process are bundled as single CommonJS files (`tsup.config.ts`).** A sandboxed preload cannot load an ES module.
- **The only workspace dependency is `@breatic/shared`.** Backend packages never enter the client.

## Electron behaviour

- **`did-fail-provisional-load` fires only when Chromium commits its error entry (not for `ERR_ABORTED`); `did-fail-load` also fires when a page that already committed loses its body.** Enter the can't-reach page on the first one only, or a server page whose stream breaks off is replaced by it.
- **The mouse side buttons need a listener only on Windows (`app-command`).** Chromium already steps history on the button press, and on Linux Electron also emits `app-command` for it, so a listener there steps twice.
- **Keep `@sentry/electron` on `IPCMode.Classic` without the `PreloadInjection` integration.** The default mode registers a privileged `sentry-ipc://` scheme the server's pages could write to.
- **Sentry starts after `app.requestSingleInstanceLock()` and only in the instance that holds it.** A second launch shares the data directory, so a Sentry started there reads the running instance's saved session and reports it as abnormal.
- **A session takes one `webRequest.onHeadersReceived` listener, and ours guards the main frame against redirects off the server.** Sentry options that install their own (`rendererProfiling`, `captureNativeStacktrace`) stay off.
- **The can't-reach page cannot load the app's stylesheet (`default-src 'none'`), so `src/unreachable/render.ts` writes out the web app's token values.** Change them together with `packages/web/src/theme/tokens.css`; `src/unreachable/__tests__/render.test.ts` compares the two.

## Packaging

- **After changing this package's dependencies, regenerate the shipped notice with `pnpm --filter @breatic/repo-lint licences`.** repo-lint `notice-travels-with-the-bundle` fails until `resources/third-party-licences.txt` matches.
- **Never write `linux.desktop.entry.Exec` in `electron-builder.config.mjs`; electron-builder adds `%U` for the scheme itself and fails the build on a custom one.** The AppImage and the deb are built in separate runs (`scripts/dist.mjs`), because the deb run leaves `resources/package-type` behind and an AppImage carrying it updates like a deb.

## Tests

- **Main-process logic is written as functions that take the Electron APIs they use; unit tests `vi.mock("electron")` and never load real Electron.** CI's unit job has no Electron binary.
- **`test:e2e` drives the real client against a running local stack (`pnpm dev`, the web app on `BREATIC_E2E_SERVER`, default `http://localhost:8100`).** Select cases with `pnpm --filter @breatic/desktop test:e2e --grep "<title>"`; with a `--` before `--grep` Playwright runs every case.
- **While a navigation is pending, Playwright's page calls (`page.evaluate`, clicks, screenshots) wait for it and time out.** Reach the page through `app.evaluate` with `webContents.mainFrame.executeJavaScript` and capture with `webContents.capturePage`.
- **Playwright's Electron launch emulates a light colour scheme.** Call `page.emulateMedia({ colorScheme: "dark" })` before checking the dark look.
- **A case that ends with a download still running blocks `app.close()` on the quit confirmation until the test times out.** Stub `dialog.showMessageBox` through `app.evaluate` (as the quit cases do) or end the run with `app.process().kill()`.
