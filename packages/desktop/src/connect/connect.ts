// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The connect window (#1599, design §6.1): first launch, Switch server, and
 * the server that cannot be reached. A local page, so it works with no server.
 */

import type { DesktopStrings } from "@desktop/main/strings.js";
import type { ConnectAnswer, ConnectInitial, ConnectReason } from "@desktop/main/connect-protocol.js";

interface ConnectApi {
  initial(): Promise<ConnectInitial>;
  connect(url: string): Promise<ConnectAnswer>;
}

const api = (window as unknown as { breaticConnect: ConnectApi }).breaticConnect;
const root = document.getElementById("root") as HTMLElement;

/**
 * The message for a refusal.
 * @param strings - The words.
 * @param reason - Why the address was refused.
 * @returns The sentence, or null when there is nothing to say.
 */
function messageFor(strings: DesktopStrings, reason: ConnectReason | null): string | null {
  switch (reason) {
    case "scheme": return strings.errors.scheme;
    case "unreachable": return strings.errors.unreachable;
    case "not_breatic": return strings.errors.notBreatic;
    case "certificate": return strings.errors.certificate;
    default: return null;
  }
}

/**
 * Make an element with text.
 * @param tag - The tag.
 * @param text - Its text.
 * @param className - Its class.
 * @returns The element.
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * Draw the "connect" state.
 * @param strings - The words.
 * @param url - The address to prefill.
 * @param reason - The refusal to show, if any.
 */
function showConnect(strings: DesktopStrings, url: string, reason: ConnectReason | null): void {
  root.replaceChildren();
  root.append(el("h1", strings.connect.title));
  const input = el("input");
  input.value = url;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", strings.connect.title);
  root.append(input);
  const message = messageFor(strings, reason);
  const error = el("p", message ?? "", "error");
  error.hidden = message === null;
  input.setAttribute("aria-invalid", String(message !== null));
  root.append(error);
  const button = el("button", strings.connect.continue);
  root.append(button);
  input.addEventListener("input", () => {
    error.hidden = true;
    input.setAttribute("aria-invalid", "false");
  });
  const submit = async (): Promise<void> => {
    button.disabled = true;
    button.textContent = strings.connect.connecting;
    const answer = await api.connect(input.value);
    if (answer.ok) return;
    showConnect(strings, input.value, answer.reason);
  };
  button.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submit();
  });
  input.focus();
}

/**
 * Draw the "cannot reach" state.
 * @param strings - The words.
 * @param url - The configured server.
 * @param reason - Why it could not be reached.
 */
function showUnreachable(strings: DesktopStrings, url: string, reason: ConnectReason | null): void {
  root.replaceChildren();
  root.append(el("h1", strings.connect.unreachableTitle), el("p", url, "address"));
  const message = reason === "certificate" ? strings.errors.certificate : null;
  if (message) root.append(el("p", message, "error"));
  const retry = el("button", strings.connect.retry);
  const change = el("button", strings.connect.change, "outline");
  retry.addEventListener("click", () => {
    retry.disabled = true;
    retry.textContent = strings.connect.connecting;
    void api.connect(url).then((answer) => {
      if (!answer.ok) showUnreachable(strings, url, answer.reason);
    });
  });
  change.addEventListener("click", () => showConnect(strings, url, null));
  root.append(retry, change);
}

void api.initial().then((initial) => {
  document.documentElement.lang = initial.lang;
  if (initial.mode === "unreachable") showUnreachable(initial.strings, initial.url, initial.reason);
  else showConnect(initial.strings, initial.url, initial.reason);
});
