// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The product guide accounts for every message the reader's screens show.
 *
 * The screens are the canvas, the document space, the project page (top bar,
 * tabs, drawer, chat) and the notification bell. A message they show is
 * either quoted by the guide, described by it, or left out for a stated
 * reason in `NOT_QUOTED`; one that is none of these fails here, so what a new
 * screen says cannot slip past the guide unnoticed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, it, expect, beforeAll } from "vitest";
import { loadLocales, runWithLocale } from "@breatic/core";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";
import { NOT_QUOTED } from "./product-guide-coverage.js";

const WEB_SRC = resolve(import.meta.dirname, "../../../../../web/src");
const SCREENS = ["spaces/canvas", "spaces/document", "pages/project", "features/notifications"];

const catalog = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../../../../locales/en.json"), "utf8"),
) as Record<string, unknown>;

/**
 * Whether a dotted id names a message in the English catalog.
 * @param id - A dotted id.
 * @returns True when the id leads to a string.
 */
function isMessage(id: string): boolean {
  let node: unknown = catalog;
  for (const part of id.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

/**
 * Every source file under a directory, tests left out.
 * @param dir - The directory to walk.
 * @returns The paths of its .ts and .tsx files.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Every message id the screens name as a string, whether handed to `t`
 * directly or kept in a table first.
 * @returns The ids, each once.
 */
function screenMessages(): Set<string> {
  const ids = new Set<string>();
  for (const screen of SCREENS) {
    for (const file of sources(join(WEB_SRC, screen))) {
      for (const match of readFileSync(file, "utf8").matchAll(/['"`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        const id = match[1] as string;
        if (isMessage(id)) ids.add(id);
      }
    }
  }
  return ids;
}

const guideSource = readFileSync(resolve(import.meta.dirname, "..", "product-guide.ts"), "utf8");
const quotedIds = new Set([...guideSource.matchAll(/t\("([\w.-]+)"\)/g)].map((m) => m[1] as string));

let guide = "";
beforeAll(() => {
  loadLocales();
  guide = runWithLocale("en", renderProductGuide);
});

describe("what the guide does with each message on the screens", () => {
  const shown = screenMessages();

  it("finds the screens' messages", () => {
    // A reading that finds nothing would pass every check below.
    expect(shown.size).toBeGreaterThan(600);
  });

  it("quotes, describes or leaves out every one of them", () => {
    const unplaced = [...shown].filter((id) => !quotedIds.has(id) && !(id in NOT_QUOTED));
    expect(unplaced).toEqual([]);
  });

  it("lists only messages the screens still show and the guide does not quote", () => {
    const stale = Object.keys(NOT_QUOTED).filter((id) => !shown.has(id) || quotedIds.has(id));
    expect(stale).toEqual([]);
  });

  it("really says each thing it is listed as describing", () => {
    const missing = Object.entries(NOT_QUOTED)
      .filter(([, place]) => "described" in place && !place.described.test(guide))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });
});
