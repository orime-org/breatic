// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The connect window (#1599, design §6.1): first launch of a build that carries no server, and
 * the server that cannot be reached. A local page, so it works with no server.
 */

import type { DesktopText } from "@desktop/main/strings.js";
import type { ConnectAnswer, ConnectInitial, ConnectReason } from "@desktop/main/connect-protocol.js";

interface ConnectApi {
  initial(): Promise<ConnectInitial>;
  connect(url: string): Promise<ConnectAnswer>;
}

const api = (window as unknown as { breaticConnect: ConnectApi }).breaticConnect;
const root = document.getElementById("root") as HTMLElement;

/**
 * The message for a refusal.
 * @param text - The words.
 * @param reason - Why the address was refused.
 * @returns The sentence, or null when there is nothing to say.
 */
function messageFor(text: DesktopText, reason: ConnectReason | null): string | null {
  switch (reason) {
    case "scheme": return text["desktop.errors.scheme"];
    case "unreachable": return text["desktop.errors.unreachable"];
    case "not_server": return text["desktop.errors.notServer"];
    case "certificate": return text["desktop.errors.certificate"];
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
 * @param text - The words.
 * @param url - The address to prefill.
 * @param reason - The refusal to show, if any.
 */
function showConnect(text: DesktopText, url: string, reason: ConnectReason | null): void {
  root.replaceChildren();
  root.append(el("h1", text["desktop.connect.title"]));
  const input = el("input");
  input.value = url;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", text["desktop.connect.title"]);
  root.append(input);
  const message = messageFor(text, reason);
  const error = el("p", message ?? "", "error");
  error.hidden = message === null;
  input.setAttribute("aria-invalid", String(message !== null));
  root.append(error);
  const button = el("button", text["desktop.connect.continue"]);
  root.append(button);
  input.addEventListener("input", () => {
    error.hidden = true;
    input.setAttribute("aria-invalid", "false");
  });
  /**
   * Check and open the address; on refusal, draw the form again with the reason.
   * @returns When the answer is shown.
   */
  const submit = async (): Promise<void> => {
    button.disabled = true;
    button.textContent = text["desktop.connect.connecting"];
    const answer = await api.connect(input.value);
    if (answer.ok) return;
    showConnect(text, input.value, answer.reason);
  };
  button.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submit();
  });
  input.focus();
}

/**
 * Draw the "cannot reach" state.
 * @param text - The words.
 * @param url - The configured server.
 * @param reason - Why it could not be reached.
 */
function showUnreachable(text: DesktopText, url: string, reason: ConnectReason | null): void {
  root.replaceChildren();
  root.append(el("h1", text["desktop.connect.unreachableTitle"]), el("p", url, "address"));
  const message = messageFor(text, reason);
  if (message) root.append(el("p", message, "error"));
  const retry = el("button", text["desktop.connect.retry"]);
  retry.addEventListener("click", () => {
    retry.disabled = true;
    retry.textContent = text["desktop.connect.connecting"];
    void api.connect(url).then((answer) => {
      if (!answer.ok) showUnreachable(text, url, answer.reason);
    });
  });
  root.append(retry);
}

void api.initial().then((initial) => {
  document.documentElement.lang = initial.lang;
  document.title = initial.product;
  if (initial.mode === "unreachable") showUnreachable(initial.text, initial.url, initial.reason);
  else showConnect(initial.text, initial.url, initial.reason);
});
