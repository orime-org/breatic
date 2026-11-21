// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** What the connect window and the main process say to each other (#1599). */

import type { DesktopText } from "@desktop/main/strings.js";

/** Why connecting did not happen. `cancelled`: the user chose to stay on a page with unsaved work. */
export type ConnectReason = "scheme" | "unreachable" | "not_breatic" | "certificate" | "cancelled";

/** The window's starting state. */
export interface ConnectInitial {
  mode: "connect" | "unreachable";
  url: string;
  reason: ConnectReason | null;
  lang: string;
  text: DesktopText;
}

/** The answer to a connect request. */
export type ConnectAnswer = { ok: true } | { ok: false; reason: ConnectReason };
