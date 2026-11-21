// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client's own words (connect window, menu, leave dialog) in the
 * operating system's language (#1599). They live in the root `locales/*.json`
 * beside the web app's, under `desktop`.
 */

import { desktop as en } from "@locales/en.json";
import { desktop as ja } from "@locales/ja.json";
import { desktop as ko } from "@locales/ko.json";
import { desktop as zhCN } from "@locales/zh-CN.json";
import { desktop as zhTW } from "@locales/zh-TW.json";

/** The words of one language. */
export type DesktopStrings = typeof en;

/**
 * The strings for the operating system's language.
 * @param locale - `app.getLocale()`, e.g. `zh-TW`, `en-US`.
 * @returns The strings, English for a language the product does not ship.
 */
export function stringsFor(locale: string): DesktopStrings {
  const lower = locale.toLowerCase();
  if (lower === "zh-tw" || lower === "zh-hk" || lower.startsWith("zh-hant")) return zhTW;
  if (lower.startsWith("zh")) return zhCN;
  if (lower.startsWith("ja")) return ja;
  if (lower.startsWith("ko")) return ko;
  return en;
}
