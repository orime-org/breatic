// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The desktop client started for real against a local server (inner#2041): the
 * server the build carries, the splash, signing in by email and staying signed
 * in after a restart, more windows, links handed to the system, "can't reach"
 * in the window that failed, the shell's error reports, and download feedback.
 *
 * Run with the dev stack up: `pnpm --filter @breatic/desktop test:e2e`. It
 * builds the client with SERVER written in (BREATIC_DEFAULT_SERVER_URL) and a
 * DSN for a local receiver; the "can't reach" cases point a development build
 * at a stand-in server of their own through BREATIC_SERVER_URL. SERVER
 * defaults to http://localhost:8100; set BREATIC_E2E_SERVER for another.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, chromium, expect, request, test, type ElectronApplication, type Page } from "playwright/test";

const SERVER = process.env.BREATIC_E2E_SERVER ?? "http://localhost:8100";
const MAIN = join(import.meta.dirname, "..", "dist", "main", "index.cjs");
/** Where the e2e build sends its error reports (the DSN in package.json's test:e2e). */
const SENTRY_PORT = 47_999;

/** The account the run made, once. */
let made: { email: string; password: string } | null = null;

/**
 * An account of this run's own, made the way the web suites make theirs:
 * through scripts/seed-smoke-account.ts, the server's own register, so the
 * sign-up rate limit stays for the cases that test signing up. Its personal
 * studio is made through the API, as the web suites' setup does.
 * @returns Email and password.
 * @throws {Error} When the script fails or the studio cannot be made.
 */
async function account(): Promise<{ email: string; password: string }> {
  if (made) return made;
  const mark = randomBytes(6).toString("hex");
  const credentials = { email: `desktop-e2e-${mark}@breatic.test`, password: randomBytes(18).toString("base64url") };
  execFileSync("pnpm", ["exec", "tsx", "--tsconfig", "packages/server/tsconfig.json", "scripts/seed-smoke-account.ts"], {
    cwd: join(import.meta.dirname, "..", "..", ".."),
    input: JSON.stringify(credentials),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const api = await request.newContext({ baseURL: SERVER });
  try {
    expect((await api.post("/api/v1/auth/login", { data: credentials })).ok()).toBe(true);
    const studio = await api.post("/api/v1/auth/setup-studio", { data: { slug: `desktop-${mark}` } });
    expect(studio.ok(), await studio.text()).toBe(true);
  } finally {
    await api.dispose();
  }
  made = credentials;
  return made;
}

/**
 * Launch the client with its own data directory.
 * @param userData - The data directory.
 * @param env - Extra environment.
 * @returns The running app.
 */
function launch(userData: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  // English, so the assertions read the same words on every machine.
  return electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, "--lang=en-US"], env: { ...launchEnv(), ...env } });
}

/**
 * The environment a launch runs with: the test's own, without a development server override.
 * @returns The environment.
 */
function launchEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BREATIC_SERVER_URL")) as Record<string, string>;
}

/**
 * The window whose URL satisfies a test.
 * @param app - The running app.
 * @param match - The test.
 * @returns The page.
 */
async function windowWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => match(w.url())), { timeout: 30_000 }).toBe(true);
  return app.windows().find((w) => match(w.url()))!;
}

/**
 * The app's windows, the splash left out.
 * @param app - The running app.
 * @returns The pages.
 */
function appWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((window) => !window.url().startsWith("file:"));
}

/**
 * Wait until the splash has closed and the first window is on screen.
 * @param app - The running app.
 */
async function afterSplash(app: ElectronApplication): Promise<void> {
  await expect.poll(() => app.windows().some((window) => window.url().includes("/splash/")), { timeout: 10_000 }).toBe(false);
}

/** A fresh data directory. */
function freshData(): string {
  return mkdtempSync(join(tmpdir(), "breatic-e2e-"));
}

/**
 * Listen on a port.
 * @param handler - What answers.
 * @param port - The port, or 0 for any.
 * @returns The listening server.
 */
function listen(handler: RequestListener, port = 0): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/**
 * Stop a server.
 * @param server - The server.
 * @returns When it has stopped.
 */
function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A stand-in server on a fixed port that a case switches on and off. */
interface StandIn {
  origin: string;
  /** Start answering every request with the handler. */
  up(handler: RequestListener): Promise<void>;
  /** Stop answering: the port refuses connections. */
  down(): Promise<void>;
}

/**
 * A stand-in server, off until a case starts it.
 * @returns The stand-in.
 */
async function standIn(): Promise<StandIn> {
  const probe = await listen(() => undefined);
  const port = (probe.address() as AddressInfo).port;
  await stop(probe);
  let server: Server | null = null;
  return {
    origin: `http://127.0.0.1:${port}`,
    up: async (handler) => {
      server = await listen(handler, port);
    },
    down: async () => {
      if (server) await stop(server);
      server = null;
    },
  };
}

/**
 * Answer with a small page of the app.
 * @param _req - The request.
 * @param res - The response.
 */
function appPage(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Studio</title><h1>Studio</h1>");
}

test("the build opens the server it carries, with no address to enter", async () => {
  const userData = freshData();
  const app = await launch(userData);
  const main = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(main).toHaveURL(/\/login/);
  await expect.poll(() => app.windows().length).toBe(1);
  // Nothing about the server is kept: the build is the only source.
  expect(existsSync(join(userData, "config.json"))).toBe(false);
  await app.close();
});

test("the splash shows the brand first, the first window stays hidden behind it, and it closes once the window is ready", async () => {
  const app = await launch(freshData());
  const splash = await windowWhere(app, (url) => url.includes("/splash/"));
  await expect(splash.getByText("Breatic", { exact: true })).toBeVisible();
  await expect(splash.getByText("powered by")).toBeHidden();
  // The page's own load start comes before it is shown; the splash must outlive it by the minimum.
  const loadStart = await splash.evaluate(() => performance.timeOrigin);
  const shownWhileSplash = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible() && !window.webContents.getURL().startsWith("file:")).length,
  );
  expect(shownWhileSplash).toBe(0);
  await expect.poll(() => app.windows().some((window) => window.url().includes("/splash/")), { timeout: 10_000 }).toBe(false);
  // At least a second on screen, so a partner's attribution can be read.
  expect(Date.now() - loadStart).toBeGreaterThanOrEqual(1_000);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length)).toBe(1);
  await app.close();
});

test("a partner's splash carries the powered-by line under its own name", async () => {
  const app = await launch(freshData());
  const splashUrl = (await windowWhere(app, (url) => url.includes("/splash/"))).url();
  const page = new URL(splashUrl);
  page.search = new URLSearchParams({ product: "Acme Studio", poweredBy: "1", logo: page.searchParams.get("logo") ?? "" }).toString();
  await app.evaluate(({ BrowserWindow }, href) => {
    void new BrowserWindow({ width: 420, height: 280 }).loadURL(href);
  }, page.toString());
  const partner = await windowWhere(app, (url) => url.includes("Acme"));
  await expect(partner.getByText("Acme Studio", { exact: true })).toBeVisible();
  await expect(partner.getByText("powered by")).toBeVisible();
  await expect(partner.locator("#powered-name")).toHaveText("Breatic");
  await expect(partner.locator(".mark")).toBeVisible();
  await app.close();
});

test("email sign-in survives a restart", async () => {
  const userData = freshData();
  const { email, password } = await account();

  const first = await launch(userData);
  const page = await windowWhere(first, (url) => url.startsWith(SERVER));
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/studio/, { timeout: 30_000 });
  await first.close();

  const second = await launch(userData);
  const again = await windowWhere(second, (url) => url.startsWith(SERVER));
  await expect(again).toHaveURL(/\/studio/, { timeout: 30_000 });
  await expect(again).not.toHaveURL(/\/login/);
  await second.close();
});

test("New Window opens another signed-in window on the Studio at once, from the menu and from a second launch", async () => {
  const { email, password } = await account();
  const app = await launch(freshData());
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await afterSplash(app);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/studio/, { timeout: 30_000 });

  await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((menu) => menu.submenu?.items ?? []) ?? [];
    items.find((item) => item.label === "New Window")?.click();
  });
  // On screen as soon as it exists, before its page has loaded.
  const visibleAtCreation = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => window.isVisible()));
  expect(visibleAtCreation).toBe(true);
  await expect.poll(() => appWindows(app).length).toBe(2);
  for (const window of appWindows(app)) await expect(window).toHaveURL(/\/studio/, { timeout: 30_000 });

  // Windows' taskbar task and the Linux launcher action start the client again with --new-window.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit("second-instance", {}, ["breatic", "--new-window"], process.cwd(), {});
  });
  await expect.poll(() => appWindows(app).length).toBe(3);
  for (const window of appWindows(app)) await expect(window).toHaveURL(/\/studio/, { timeout: 30_000 });
  await app.close();
});

test("on macOS, closing every window and clicking the Dock icon reopens the server", async () => {
  test.skip(process.platform !== "darwin", "the app stays open without windows only on macOS");
  const app = await launch(freshData());
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(page).toHaveURL(/\/login/);
  await afterSplash(app);
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await expect.poll(() => appWindows(app).length).toBe(0);
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit("activate");
  });
  const reopened = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(reopened).toHaveURL(/\/login/);
  await app.close();
});

test("on Windows and Linux, closing the last window ends the app", async () => {
  test.skip(process.platform === "darwin", "macOS keeps the app in the Dock");
  const app = await launch(freshData());
  await windowWhere(app, (url) => url.startsWith(SERVER));
  await afterSplash(app);
  const ended = app.waitForEvent("close");
  void app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  }).catch(() => undefined);
  await ended;
});

test("a link to another site goes to the system browser and the window stays", async () => {
  const app = await launch(freshData());
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(page).toHaveURL(/\/login/);
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const before = page.url();
  await page.evaluate(() => window.open("https://example.com/", "_blank"));
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])).toEqual(["https://example.com/"]);
  expect(page.url()).toBe(before);
  expect(appWindows(app)).toHaveLength(1);
  await app.close();
});

test("Back to home on a missing project's page stays in the window and opens the Studio", async () => {
  const { email, password } = await account();
  const app = await launch(freshData());
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/studio/, { timeout: 30_000 });
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  await page.goto(`${SERVER}/project/${randomUUID()}`);
  await expect(page.getByTestId("not-found-page")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(`${SERVER}/studio`, { timeout: 30_000 });
  expect(await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])).toEqual([]);
  await app.close();
});

test.describe("can't reach the server", () => {
  let server: StandIn;

  test.beforeEach(async () => {
    server = await standIn();
  });

  test.afterEach(async () => {
    await server.down();
  });

  /**
   * Launch a development build on the stand-in.
   * @returns The app and its window.
   */
  async function launchOnStandIn(): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await launch(freshData(), { BREATIC_SERVER_URL: server.origin });
    const page = await windowWhere(app, (url) => !url.startsWith("file:"));
    return { app, page };
  }

  test("shows in the window that failed, retries by itself and comes back when the server answers", async () => {
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`${server.origin}/studio`)).toBeVisible();
    await expect(page.getByText("Can't reach this address")).toBeVisible();
    await expect(page.getByText("Retrying automatically")).toBeVisible();
    // Once the splash closes, the window shows it under its own title; it is never hidden.
    await afterSplash(app);
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => [window.getTitle(), window.isVisible()])))
      .toEqual([["Can't reach Breatic", true]]);

    await server.up(appPage);
    // The first automatic retry comes 5 s after the failure.
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(`${server.origin}/studio`);
    // The error entry turned back into the page: no history entry was added.
    expect(await page.evaluate(() => history.length)).toBe(1);
    await app.close();
  });

  test("Retry tries again at once", async () => {
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible({ timeout: 30_000 });
    await server.up(appPage);
    const clicked = Date.now();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    // Well before the 5 s automatic retry.
    expect(Date.now() - clicked).toBeLessThan(4_000);
    await app.close();
  });

  test("Reload tries again, and once the server answers the window keeps the server's page", async () => {
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible({ timeout: 30_000 });
    await server.up(appPage);
    // What Reload in the View menu and Cmd+R do.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().startsWith("file:"))!
        .webContents.reload();
    });
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    // Nothing is drawn over the server's page once it has loaded.
    await page.waitForTimeout(1_500);
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    await expect(page.getByText("Can't reach Breatic")).toHaveCount(0);
    await app.close();
  });

  test("a server page whose body breaks off after it has opened stays, and is not reloaded", async () => {
    let requests = 0;
    await server.up((req, res) => {
      if (req.url === "/studio") requests += 1;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(`<!doctype html><title>Studio</title><h1>Studio</h1>${" ".repeat(4096)}`);
      setTimeout(() => req.socket.destroy(), 300);
    });
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 30_000 });
    // Past the first automatic retry, which would come 5 s after a failure.
    await page.waitForTimeout(6_500);
    expect(requests).toBe(1);
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    await app.close();
  });

  test("the network coming back retries at once", async () => {
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible({ timeout: 30_000 });
    await server.up(appPage);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const conditions = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await cdp.send("Network.emulateNetworkConditions", { offline: true, ...conditions });
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    const online = Date.now();
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...conditions });
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    // Well before the 5 s automatic retry.
    expect(Date.now() - online).toBeLessThan(4_000);
    await app.close();
  });

  test("the network coming back waits for a Back that is still loading, and Retry still goes", async () => {
    /** The app's pages, never from the cache. */
    const fresh = (_req: IncomingMessage, res: ServerResponse): void => {
      res.setHeader("Cache-Control", "no-store");
      appPage(_req, res);
    };
    await server.up(fresh);
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 30_000 });
    await server.down();
    await page.goto(`${server.origin}/project/1`).catch(() => undefined);
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible();
    // The server is back, but the Studio the user goes back to is slow to answer.
    let retries = 0;
    await server.up((req, res) => {
      if (req.url === "/studio") return;
      if (req.url === "/project/1") retries += 1;
      fresh(req, res);
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().startsWith("file:"))!
        .webContents.navigationHistory.goBack();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().startsWith("file:"))!.webContents.isLoading()))
      .toBe(true);
    /** Run a script in the error entry at once; Playwright's own calls wait for the pending Back. */
    const inErrorEntry = (script: string): Promise<unknown> =>
      app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().startsWith("file:"))!.webContents.mainFrame.executeJavaScript(code), script);
    await inErrorEntry(`window.dispatchEvent(new Event("online"))`);
    await page.waitForTimeout(1_000);
    expect(retries).toBe(0);
    await inErrorEntry(`document.querySelector("button").click()`);
    await expect.poll(() => retries).toBe(1);
    await app.close();
  });

  test("a page on the server cannot ask for a retry", async () => {
    await server.up(appPage);
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 30_000 });
    let requests = 0;
    await server.down();
    await server.up((req, res) => {
      requests += 1;
      appPage(req, res);
    });
    await page.evaluate(() => (window as unknown as { breaticDesktop: { retry(): Promise<void> } }).breaticDesktop.retry());
    await page.waitForTimeout(1_000);
    expect(requests).toBe(0);
    await app.close();
  });

  test("the mouse's back and forward buttons step through the window's history", async () => {
    await server.up(appPage);
    const { app, page } = await launchOnStandIn();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 30_000 });
    await page.goto(`${server.origin}/project/1`);
    await page.goto(`${server.origin}/project/2`);
    /** Press and release a mouse side button over the page, as the operating system delivers it. */
    const press = async (button: "back" | "forward"): Promise<void> => {
      const cdp = await page.context().newCDPSession(page);
      for (const type of ["mousePressed", "mouseReleased"] as const) {
        await cdp.send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button, clickCount: 1 });
      }
      await cdp.detach();
    };
    await press("back");
    await expect(page).toHaveURL(`${server.origin}/project/1`);
    await press("forward");
    await expect(page).toHaveURL(`${server.origin}/project/2`);
    // On Linux Electron also sends an app command for the same press, which a listener would turn into a second step.
    if (process.platform !== "win32") {
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => window.listenerCount("app-command") === 0))).toBe(true);
    }
    await app.close();
  });

  test("a Back from the can't-reach page that is cancelled before it commits leaves the page working", async () => {
    /** The app's pages, never from the cache, so Back asks the server again. */
    const fresh = (_req: IncomingMessage, res: ServerResponse): void => {
      res.setHeader("Cache-Control", "no-store");
      appPage(_req, res);
    };
    await server.up(fresh);
    const { app, page } = await launchOnStandIn();
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 30_000 });
    await server.down();
    await page.goto(`${server.origin}/project/1`).catch(() => undefined);
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible();
    // The server comes back behind a sign-in proxy: Back to the Studio is sent out of the window and cancelled.
    await server.up((req, res) => {
      if (req.url === "/studio") {
        res.statusCode = 302;
        res.setHeader("Location", "/oauth2/sign_in");
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }
      fresh(req, res);
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().startsWith("file:"))!
        .webContents.navigationHistory.goBack();
    });
    await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])).toEqual([`${server.origin}/oauth2/sign_in`]);
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().startsWith("file:"))!.webContents.isLoading()))
      .toBe(false);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    await expect(page).toHaveURL(`${server.origin}/project/1`);
    await app.close();
  });

  for (const [label, location, shown] of [
    ["another site", "https://www.example.test/landing?ref=desktop", () => "https://www.example.test/landing"],
    ["a page of the server outside the app", "/oauth2/sign_in?rd=%2Fstudio", () => `${server.origin}/oauth2/sign_in`],
  ] as const) test(`a server address that redirects to ${label} says where it went and opens nothing`, async () => {
    await server.up((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", location);
      res.end();
    });
    const { app, page } = await launchOnStandIn();
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await expect(page.getByRole("heading", { name: "Can't reach Breatic" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`This address goes to ${shown()}`)).toBeVisible();
    expect(await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])).toEqual([]);
    await app.close();
  });
});

test("the shell reports a session per launch and its errors under the brand, without queries, and pages cannot reach its channel", async () => {
  const bodies: string[] = [];
  const receiver = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.end("{}");
    });
  }, SENTRY_PORT);
  try {
    const userData = freshData();
    const app = await launch(userData);
    const page = await windowWhere(app, (url) => url.startsWith(SERVER));

    // A second launch hands its arguments to this one and ends, reporting nothing of its own.
    const executable = await app.evaluate(() => process.execPath);
    const second = spawn(executable, [MAIN, `--user-data-dir=${userData}`, "--lang=en-US"], { env: launchEnv(), stdio: "ignore" });
    await new Promise((resolve) => second.once("exit", resolve));

    await app.evaluate(() => {
      void Promise.reject(new Error("e2e failure at https://studio.example.test/reset?token=SECRET"));
    });
    await expect.poll(() => bodies.some((body) => body.includes("e2e failure")), { timeout: 20_000 }).toBe(true);
    const report = bodies.find((body) => body.includes("e2e failure"))!;
    expect(report).toContain('"brand":"breatic"');
    expect(report).toContain("https://studio.example.test/reset");
    expect(report).not.toContain("SECRET");

    // The classic IPC registers no privileged scheme a server page could write to.
    const reached = await page.evaluate(() => fetch("sentry-ipc://scope/x", { method: "POST", body: "{}" }).then(() => true, () => false));
    expect(reached).toBe(false);

    // The launch's session record goes out when the session ends, at quit.
    await app.close();
    await expect.poll(() => bodies.some((body) => body.includes('"type":"session"')), { timeout: 10_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const sessions = bodies.filter((body) => body.includes('"type":"session"'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toContain('"status":"abnormal"');
  } finally {
    await stop(receiver);
  }
});

test("browser sign-in hands the account to the client through a link on its scheme", async () => {
  const { email, password } = await account();
  const app = await launch(freshData());
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(page).toHaveURL(/\/login/);
  // The system browser is a separate Chromium here; record what the client asks it to open.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByText("Continue in your browser")).toBeVisible();
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened?.length ?? 0)).toBe(1);
  const signInUrl = await app.evaluate(() => (globalThis as { opened?: string[] }).opened![0]!);
  expect(new URL(signInUrl).pathname).toBe("/desktop/sign-in");

  const browser = await chromium.launch();
  const tab = await browser.newPage({ locale: "en-US" });
  const links: string[] = [];
  tab.on("request", (request) => {
    if (request.url().startsWith("ai.breatic.desktop:")) links.push(request.url());
  });
  await tab.goto(signInUrl);
  await expect(tab).toHaveURL(/\/login/);
  await tab.getByLabel("Email").fill(email);
  await tab.getByRole("textbox", { name: "Password" }).fill(password);
  await tab.getByRole("button", { name: "Sign in" }).click();
  // Signing in switches the page to the account's own language, so the confirm
  // step is found by the account it names and its first button, Continue.
  await expect(tab.getByText(email)).toBeVisible({ timeout: 30_000 });
  await tab.getByRole("main").getByRole("button").first().click();
  await expect.poll(() => links.length).toBeGreaterThan(0);
  await browser.close();

  // macOS delivers the link through open-url; Windows and Linux through the launch arguments.
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit("open-url", { preventDefault: () => undefined }, link);
  }, links[0]!);
  await expect(page).toHaveURL(/\/studio/, { timeout: 30_000 });
  await app.close();
});


test.describe("download feedback", () => {
  let files: StandIn;

  test.beforeAll(async () => {
    files = await standIn();
  });

  test.afterEach(async () => {
    await files.down();
  });

  /**
   * Save every download into a directory without the save dialog, as a user picking it would.
   * @param app - The running app.
   * @param dir - Where downloads go.
   */
  async function saveInto(app: ElectronApplication, dir: string): Promise<void> {
    await app.evaluate(({ session }, target) => {
      session.defaultSession.on("will-download", (_event, item) => item.setSavePath(`${target}/${item.getFilename()}`));
    }, dir);
  }

  /**
   * Start a download in the first visible window, as the client does for an asset link.
   * @param app - The running app.
   * @param url - What to download.
   */
  async function download(app: ElectronApplication, url: string): Promise<void> {
    await app.evaluate(({ BrowserWindow }, link) => {
      BrowserWindow.getAllWindows().find((window) => window.isVisible())!.webContents.downloadURL(link);
    }, url);
  }

  test("a download shows in the Downloads panel, stays across a reload and in a new window, reveals its file, and says when the file has gone", async () => {
    const app = await launch(freshData());
    const page = await windowWhere(app, (url) => url.startsWith(SERVER));
    await afterSplash(app);
    const dir = mkdtempSync(join(tmpdir(), "breatic-download-"));
    await saveInto(app, dir);
    await app.evaluate(({ shell }) => {
      shell.showItemInFolder = (path: string) => {
        (globalThis as { revealed?: string }).revealed = path;
      };
    });
    await files.up((_req, res) => {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", 'attachment; filename="clip.bin"');
      res.end(randomBytes(64 * 1024));
    });
    await download(app, `${files.origin}/clip.bin`);

    const panel = page.getByTestId("desktop-download-panel");
    await expect(panel.getByText("clip.bin")).toBeVisible({ timeout: 30_000 });
    const folder = dir.split("/").at(-1)!;
    await expect(panel.getByText(`Saved in ${folder}`)).toBeVisible();
    expect(existsSync(join(dir, "clip.bin"))).toBe(true);
    await panel.getByRole("button", { name: process.platform === "darwin" ? "Show in Finder" : "Show in folder" }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { revealed?: string }).revealed)).toBe(join(dir, "clip.bin"));

    await page.reload();
    await expect(page.getByTestId("desktop-download-panel").getByText("clip.bin")).toBeVisible({ timeout: 30_000 });

    await app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()?.items.flatMap((menu) => menu.submenu?.items ?? []) ?? [];
      items.find((item) => item.label === "New Window")?.click();
    });
    await expect.poll(() => appWindows(app).filter((window) => window.url().startsWith(SERVER)).length).toBe(2);
    const second = appWindows(app).filter((window) => window.url().startsWith(SERVER)).find((window) => window !== page)!;
    await expect(second.getByTestId("desktop-download-panel").getByText("clip.bin")).toBeVisible({ timeout: 30_000 });

    // The file moved away since: showing it says so, in every window.
    rmSync(join(dir, "clip.bin"));
    await second.getByTestId("desktop-download-panel").getByRole("button", { name: process.platform === "darwin" ? "Show in Finder" : "Show in folder" }).click();
    await expect(page.getByTestId("desktop-download-panel").getByText("File moved or deleted")).toBeVisible();
    await app.close();
  });

  for (const how of ["quit", "close the last window"] as const) {
    test(`with a download running, ${how} asks once and then ends the app`, async () => {
      test.skip(how === "close the last window" && process.platform === "darwin", "macOS keeps the app running without windows");
      const app = await launch(freshData());
      const page = await windowWhere(app, (url) => url.startsWith(SERVER));
      await afterSplash(app);
      await saveInto(app, mkdtempSync(join(tmpdir(), "breatic-download-")));
      const asked = join(mkdtempSync(join(tmpdir(), "breatic-asked-")), "asked.txt");
      // Record each quit dialog in a file, which outlives the app, and answer Quit.
      await app.evaluate(({ dialog }, file) => {
        const fs = process.getBuiltinModule("node:fs");
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as { message?: string };
          fs.appendFileSync(file, `${options.message ?? ""}\n`);
          return { response: 0, checkboxChecked: false };
        });
      }, asked);
      // A body that never ends keeps the download running.
      await files.up((_req, res) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", 'attachment; filename="long.bin"');
        res.setHeader("Content-Length", String(64 * 1024 * 1024));
        res.write(randomBytes(64 * 1024));
      });
      await download(app, `${files.origin}/long.bin`);
      await expect(page.getByTestId("desktop-download-panel").getByText("long.bin")).toBeVisible({ timeout: 30_000 });

      const ended = app.waitForEvent("close");
      if (how === "quit") {
        void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
      } else {
        void app.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.close();
        }).catch(() => undefined);
      }
      await ended;
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(asked, "utf-8").trim().split("\n")).toEqual(["1 download is in progress"]);
    });
  }
});
