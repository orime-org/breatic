// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The client's own words ("can't reach" page, menu, leave and update dialogs) in the
 * operating system's language (inner#2041). They live in the root `locales/*.json`
 * beside the web app's, under `desktop`, and are read by their full key, as
 * the web app reads its own.
 */

import { desktop as en } from "@locales/en.json";
import { desktop as ja } from "@locales/ja.json";
import { desktop as ko } from "@locales/ko.json";
import { desktop as zhCN } from "@locales/zh-CN.json";
import { desktop as zhTW } from "@locales/zh-TW.json";

/** Every dotted key under a section, e.g. `desktop.unreachable.title`. */
type Leaves<T, P extends string> = {
  [K in keyof T & string]: T[K] extends string ? `${P}.${K}` : Leaves<T[K], `${P}.${K}`>;
}[keyof T & string];

/** A key of the client's own words. */
export type DesktopKey = Leaves<typeof en, "desktop">;

/** Every key with its text. */
export type DesktopText = Record<DesktopKey, string>;

/**
 * The section for the operating system's language.
 * @param locale - `app.getLocale()`, e.g. `zh-TW`, `en-US`.
 * @returns The section, English for a language the product does not ship.
 */
function sectionFor(locale: string): typeof en {
  const lower = locale.toLowerCase();
  if (lower === "zh-tw" || lower === "zh-hk" || lower.startsWith("zh-hant")) return zhTW;
  if (lower.startsWith("zh")) return zhCN;
  if (lower.startsWith("ja")) return ja;
  if (lower.startsWith("ko")) return ko;
  return en;
}

/**
 * Every key of the client's words with its text in a language, the app named
 * by the build's product name wherever a text holds `{product}`.
 * @param locale - `app.getLocale()`.
 * @param product - The build's product name.
 * @returns The flat table.
 */
export function desktopText(locale: string, product: string): DesktopText {
  const table: Record<string, string> = {};
  /**
   * Walk a section, recording each string under its dotted key.
   * @param node - The section or a nested object.
   * @param prefix - The key so far.
   */
  const walk = (node: object, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      if (typeof value === "string") table[`${prefix}.${name}`] = value.replaceAll("{product}", product);
      else if (typeof value === "object" && value !== null) walk(value, `${prefix}.${name}`);
    }
  };
  walk(sectionFor(locale), "desktop");
  return table as DesktopText;
}
