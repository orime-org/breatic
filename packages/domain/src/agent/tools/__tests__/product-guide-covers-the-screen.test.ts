// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The product guide accounts for every message the reader's screens show.
 *
 * The screens are what the project page renders: the canvas and document
 * spaces, the space type picker, the project page itself (top bar, tabs,
 * drawer, chat), the features it mounts, the refusals the shared rules hand
 * the panels, the running lines of the agent's tools, and the server's
 * answers the top bar's dialogs show as they come. A message they show is
 * quoted by the guide, described by it, or left out for a stated reason in
 * `NOT_QUOTED`; one that is none of these fails here, so what a new screen
 * says cannot slip past the guide unnoticed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, it, expect, beforeAll } from "vitest";
import { loadLocales, runWithLocale } from "@breatic/core";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";
import { NOT_QUOTED, REASONS } from "./product-guide-coverage.js";

const PACKAGES = resolve(import.meta.dirname, "../../../../..");
/** Where the reader's screens take their messages from, relative to `packages/`. */
const SCREENS = [
  "web/src/spaces",
  "web/src/pages/project",
  "web/src/components/resource-load-error.tsx",
  ...["active-region", "collab-editor", "exclusive-overlay", "notifications", "preferences", "project-join"].map(
    (feature) => `web/src/features/${feature}`,
  ),
  "shared/src",
  "domain/src/agent/tools",
  "server/src/modules/project-invite/projectInvite.service.ts",
  "server/src/modules/project/projectMembers.service.ts",
  "server/src/modules/project/projectTransfer.service.ts",
];

const catalog = JSON.parse(
  readFileSync(resolve(PACKAGES, "../locales/en.json"), "utf8"),
) as Record<string, unknown>;

/**
 * Every message in the English catalog, by id.
 * @param node - A branch of the catalog.
 * @param prefix - The id of that branch.
 * @returns Each message's id with its English text.
 */
function flatten(node: unknown, prefix = ""): [string, string][] {
  if (typeof node === "string") return [[prefix, node]];
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key));
}

const messages = new Map(flatten(catalog));

/**
 * Every source file at a path, tests left out.
 * @param path - A directory or a file.
 * @returns The paths of its .ts and .tsx files.
 */
function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return name === "__tests__" ? [] : sources(child);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [child] : [];
  });
}

/**
 * Every message id the screens can show: each written out as a string, and
 * every message under a prefix a template string completes at run time.
 * @returns The ids, each once.
 */
function screenMessages(): Set<string> {
  const ids = new Set<string>();
  for (const screen of SCREENS) {
    for (const file of sources(join(PACKAGES, screen))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/['"`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (messages.has(match[1] as string)) ids.add(match[1] as string);
      }
      for (const match of text.matchAll(/`([a-zA-Z][\w-]*(?:\.[\w-]+)*)\.\$\{/g)) {
        const prefix = `${match[1] as string}.`;
        for (const id of messages.keys()) if (id.startsWith(prefix)) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Whether the rendered guide carries a message: every stretch of its text
 * between placeholders of four or more characters is in the guide, or, for a
 * message too short to have one, the whole message between quotes.
 * @param id - A message id.
 * @param text - The rendered guide.
 * @returns True when the guide shows it.
 */
function shows(id: string, text: string): boolean {
  const pieces = (messages.get(id) ?? "")
    .split(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 4);
  if (pieces.length === 0) return text.includes(`"${messages.get(id) ?? ""}"`);
  return pieces.every((piece) => text.includes(piece));
}

const guideSource = readFileSync(resolve(import.meta.dirname, "..", "product-guide.ts"), "utf8");
const calledIds = new Set([...guideSource.matchAll(/\bt\("([\w.-]+)"/g)].map((m) => m[1] as string));

let guide = "";
beforeAll(() => {
  loadLocales();
  guide = runWithLocale("en", renderProductGuide);
});

describe("what the guide does with each message on the screens", () => {
  const shown = screenMessages();

  let quotedIds = new Set<string>();
  beforeAll(() => {
    // Quoted means the rendered guide carries it, not that the source names it:
    // a commented-out line or an uncalled helper still names the id.
    quotedIds = new Set([...calledIds].filter((id) => shows(id, guide)));
  });

  it("finds the screens' messages", () => {
    // A reading that finds nothing would pass every check below.
    expect(shown.size).toBeGreaterThan(700);
  });

  it("shows every message the guide's source calls for", () => {
    expect([...calledIds].filter((id) => !quotedIds.has(id))).toEqual([]);
  });

  it("quotes, describes or leaves out every one of them", () => {
    const unplaced = [...shown].filter((id) => !quotedIds.has(id) && !(id in NOT_QUOTED));
    expect(unplaced).toEqual([]);
  });

  it("lists only messages the screens still show and the guide does not quote", () => {
    const stale = Object.keys(NOT_QUOTED).filter((id) => !shown.has(id) || quotedIds.has(id));
    expect(stale).toEqual([]);
  });

  it("describes by look every control whose name only a screen reader hears", () => {
    const unseen = Object.entries(NOT_QUOTED)
      .filter(([, place]) => "excluded" in place && place.excluded === REASONS.SCREEN_READER)
      .filter(([, place]) => !("look" in place && place.look !== undefined && place.look.test(guide)))
      .map(([id]) => id);
    expect(unseen).toEqual([]);
  });

  it("leaves out as asking to try again only messages that do", () => {
    const misfiled = Object.entries(NOT_QUOTED)
      .filter(([, place]) => "excluded" in place && place.excluded === REASONS.SAYS_TRY_AGAIN)
      .filter(([id]) => !/try again|reload|refresh|retry/i.test(messages.get(id) ?? ""))
      .map(([id]) => id);
    expect(misfiled).toEqual([]);
  });

  it("really says each thing it is listed as describing", () => {
    const missing = Object.entries(NOT_QUOTED)
      .filter(([, place]) => "described" in place && !place.described.test(guide))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });
});
