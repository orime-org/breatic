// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "can't reach" page (#1599, design 5.3). The main process writes it into
 * Chromium's error entry with `executeJavaScript`: the code is this fixed
 * function, and everything that comes from the network (the address, the
 * redirect target) arrives only as its JSON argument and is written with
 * `textContent`.
 */

/** What the page shows, every string already in the user's language. */
export interface UnreachablePage {
  lang: string;
  /** "Can't reach {product}": the heading and the window title. */
  title: string;
  /** The address that failed. */
  address: string;
  /** Why, one of the three reasons of design 6.2. */
  reason: string;
  retry: string;
  /** The line under the button: "Retrying automatically". */
  retrying: string;
  /** A retry is in flight: the button shows it is busy. */
  busy: boolean;
}

/**
 * Draw the page into the current document. Runs inside the error entry, so it
 * refers to nothing outside its own body.
 * @param page - What to show.
 */
function renderUnreachable(page: UnreachablePage): void {
  const css = `
:root { color-scheme: light dark; --bg: #f4f4f5; --text: #18181b; --muted: #71717a; --primary: #18181b; --primary-text: #ffffff; --error: #dc3e42; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --text: #fafafa; --muted: #a1a1aa; --primary: #fafafa; --primary-text: #18181b; --error: #e5484d; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans", "Noto Sans", sans-serif; }
main { width: 340px; display: flex; flex-direction: column; gap: 12px; }
h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; text-align: center; }
.address { margin: 0; color: var(--muted); text-align: center; word-break: break-all; }
.reason { margin: -4px 0 0; color: var(--error); font-size: 12px; text-align: center; }
.status { margin: -4px 0 0; color: var(--muted); font-size: 12px; text-align: center; }
button { height: 40px; border-radius: 999px; border: 1px solid var(--primary); background: var(--primary); color: var(--primary-text); font: inherit; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
button:focus-visible { outline: 1px solid var(--text); outline-offset: 2px; }
button:disabled { opacity: 0.6; cursor: default; }
.spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
`;
  const doc = document;
  const bridge = (window as unknown as { breaticDesktop?: { retry?: () => Promise<void> } }).breaticDesktop;
  doc.documentElement.lang = page.lang;
  doc.title = page.title;
  if (!doc.querySelector("meta[data-desktop-unreachable]")) {
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "default-src 'none'";
    policy.setAttribute("data-desktop-unreachable", "");
    doc.head.append(policy);
    window.addEventListener("online", () => void bridge?.retry?.());
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  doc.adoptedStyleSheets = [sheet];

  const main = doc.createElement("main");
  const heading = doc.createElement("h1");
  heading.textContent = page.title;
  const address = doc.createElement("p");
  address.className = "address";
  address.textContent = page.address;
  const reason = doc.createElement("p");
  reason.className = "reason";
  reason.textContent = page.reason;
  const button = doc.createElement("button");
  button.type = "button";
  button.disabled = page.busy;
  if (page.busy) {
    const spinner = doc.createElement("span");
    spinner.className = "spin";
    button.append(spinner);
  }
  button.append(page.retry);
  button.addEventListener("click", () => void bridge?.retry?.());
  const status = doc.createElement("p");
  status.className = "status";
  status.textContent = page.retrying;
  main.append(heading, address, reason, button, status);
  doc.body.replaceChildren(main);
}

/**
 * The script the main process runs in the error entry.
 * @param page - What to show.
 * @returns The fixed function called with the page as JSON.
 */
export function unreachableScript(page: UnreachablePage): string {
  return `(${renderUnreachable.toString()})(${JSON.stringify(page)});`;
}
