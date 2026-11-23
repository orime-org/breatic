// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop client started for real against a local server (#1599): first
 * launch, the address rules, signing in by email and staying signed in after a
 * restart, more windows, links handed to the system, and a server that cannot
 * be reached.
 *
 * Run with the dev stack up: `pnpm --filter @breatic/desktop test:e2e`. It
 * builds the client as a brand that carries no server (e2e/brand-without-server),
 * so the address rules and the connect window are what the cases exercise.
 * SERVER defaults to the worktree's own web port; set BREATIC_E2E_SERVER for another.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from "playwright/test";

const SERVER = process.env.BREATIC_E2E_SERVER ?? "http://localhost:8100";
const MAIN = join(import.meta.dirname, "..", "dist", "main", "index.cjs");

/**
 * The first account in the worktree's untracked `tasks/test_account`.
 * @returns Email and password.
 */
function account(): { email: string; password: string } {
  const text = readFileSync(join(import.meta.dirname, "..", "..", "..", "tasks", "test_account"), "utf8");
  const row = text.split("\n").find((line) => /^\S+@\S+\s+\S+/.test(line));
  if (!row) throw new Error("tasks/test_account holds no account row");
  const [email, password] = row.trim().split(/\s+/);
  return { email: email!, password: password! };
}

/**
 * Launch the client with its own data directory.
 * @param userData - The data directory.
 * @param env - Extra environment.
 * @returns The running app.
 */
function launch(userData: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BREATIC_SERVER_URL")) as Record<string, string>;
  // English, so the assertions read the same words on every machine.
  return electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, "--lang=en-US"], env: { ...base, ...env } });
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
 * The app's windows on the server, the splash and the connect window left out.
 * @param app - The running app.
 * @returns The pages.
 */
function appWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((window) => !window.url().startsWith("file:"));
}

/** A fresh data directory. */
function freshData(): string {
  return mkdtempSync(join(tmpdir(), "breatic-e2e-"));
}

test("first launch: the connect window refuses LAN http, connects to the server and remembers it", async () => {
  const userData = freshData();
  const app = await launch(userData);
  const connect = await windowWhere(app, (url) => url.includes("/connect/"));
  await expect(connect.getByRole("heading", { name: "Connect to breatic" })).toBeVisible();

  const input = connect.getByRole("textbox");
  await input.fill("http://192.168.1.50");
  await connect.getByRole("button", { name: "Continue" }).click();
  await expect(connect.getByText("A LAN or internet address needs HTTPS")).toBeVisible();

  await connect.getByRole("textbox").fill(SERVER);
  await connect.getByRole("button", { name: "Continue" }).click();
  const main = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(main).toHaveURL(/\/login/);
  expect(JSON.parse(readFileSync(join(userData, "config.json"), "utf8"))).toEqual({ serverUrl: SERVER });
  await app.close();
});

test("the splash shows the brand first and closes once a window is ready", async () => {
  const app = await launch(freshData());
  const splash = await windowWhere(app, (url) => url.includes("/splash/"));
  await expect(splash.getByText("breatic", { exact: true })).toBeVisible();
  await expect(splash.getByText("powered by")).toBeHidden();
  // The page's own load start comes before it is shown; the splash must outlive it by the minimum.
  const loadStart = await splash.evaluate(() => performance.timeOrigin);
  await windowWhere(app, (url) => url.includes("/connect/"));
  await expect.poll(() => app.windows().some((window) => window.url().includes("/splash/")), { timeout: 10_000 }).toBe(false);
  // At least a second on screen, so a partner's attribution can be read.
  expect(Date.now() - loadStart).toBeGreaterThanOrEqual(1_000);
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
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: SERVER }));
  const { email, password } = account();

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

test("New Window opens another signed-in window on the Studio, from the menu and from a second launch", async () => {
  const userData = freshData();
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: SERVER }));
  const { email, password } = account();
  const app = await launch(userData);
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/studio/, { timeout: 30_000 });

  await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((menu) => menu.submenu?.items ?? []) ?? [];
    items.find((item) => item.label === "New Window")?.click();
  });
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
  const userData = freshData();
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: SERVER }));
  const app = await launch(userData);
  const page = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(page).toHaveURL(/\/login/);
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await expect.poll(() => appWindows(app).length).toBe(0);
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit("activate");
  });
  const reopened = await windowWhere(app, (url) => url.startsWith(SERVER));
  await expect(reopened).toHaveURL(/\/login/);
  expect(app.windows().some((window) => window.url().includes("/connect/"))).toBe(false);
  await app.close();
});

test("a link to another site goes to the system browser and the window stays", async () => {
  const userData = freshData();
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: SERVER }));
  const app = await launch(userData);
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

test("a configured server that cannot be reached opens the unreachable state", async () => {
  const userData = freshData();
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: "http://localhost:9" }));
  const app = await launch(userData);
  const connect = await windowWhere(app, (url) => url.includes("/connect/"));
  await expect(connect.getByRole("heading", { name: "Can't reach breatic" })).toBeVisible();
  await expect(connect.getByText("http://localhost:9")).toBeVisible();
  await expect(connect.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(connect.getByRole("button", { name: "Use another server" })).toHaveCount(0);
  await connect.getByRole("button", { name: "Retry" }).click();
  await expect(connect.getByText("Can't reach this address")).toBeVisible();
  if (process.platform === "darwin") {
    // Closed and reopened from the Dock, it comes back to the same server, never to an empty address form.
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await expect.poll(() => app.windows().length).toBe(0);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("activate");
    });
    const again = await windowWhere(app, (url) => url.includes("/connect/"));
    await expect(again.getByRole("heading", { name: "Can't reach breatic" })).toBeVisible();
    await expect(again.getByText("http://localhost:9")).toBeVisible();
  }
  await app.close();
});

test("browser sign-in hands the account to the client through a link on its scheme", async () => {
  const userData = freshData();
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: SERVER }));
  const { email, password } = account();
  const app = await launch(userData);
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
  await expect(page.getByText("Finish signing in in your browser")).toBeVisible();
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

