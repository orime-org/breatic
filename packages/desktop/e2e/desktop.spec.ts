// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop client started for real against a local server (#1599): first
 * launch, the address rules, signing in by email and staying signed in after a
 * restart, links handed to the system, and a server that cannot be reached.
 *
 * Run with the dev stack up: `pnpm --filter @breatic/desktop test:e2e`.
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

/** A fresh data directory. */
function freshData(): string {
  return mkdtempSync(join(tmpdir(), "breatic-e2e-"));
}

test("first launch: the connect window refuses LAN http, connects to the server and remembers it", async () => {
  const userData = freshData();
  const app = await launch(userData);
  const connect = await windowWhere(app, (url) => url.startsWith("file:"));
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
  expect(app.windows()).toHaveLength(1);
  await app.close();
});

test("a configured server that cannot be reached opens the unreachable state", async () => {
  const userData = freshData();
  writeFileSync(join(userData, "config.json"), JSON.stringify({ serverUrl: "http://localhost:9" }));
  const app = await launch(userData);
  const connect = await windowWhere(app, (url) => url.startsWith("file:"));
  await expect(connect.getByRole("heading", { name: "Can't reach breatic" })).toBeVisible();
  await expect(connect.getByText("http://localhost:9")).toBeVisible();
  await expect(connect.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(connect.getByRole("button", { name: "Use another server" })).toHaveCount(0);
  await app.close();
});

test("browser sign-in hands the account to the client through a breatic:// link", async () => {
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
    if (request.url().startsWith("breatic:")) links.push(request.url());
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

