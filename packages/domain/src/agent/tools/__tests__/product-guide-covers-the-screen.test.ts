// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The product guide accounts for every message the reader's screens show.
 *
 * The screens are what the project page renders: every web module reachable
 * by import from the app's entry and the project page (the route table that
 * would pull in every other page is left out), the shared rules those modules
 * use, and the server, domain and core sources, whose messages the page shows
 * as the server's answers. A message they show
 * is quoted by the guide, described by it, or left out for a stated reason in
 * `NOT_QUOTED`; one that is none of these fails here, so what a new screen
 * says cannot slip past the guide unnoticed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadLocales, runWithLocale } from "@breatic/core";
import type * as Shared from "@breatic/shared";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";
import { NOT_QUOTED, REASONS } from "./product-guide-coverage.js";

/** Every message id the guide asked `t` for while rendering. */
const rendered = new Set<string>();

vi.mock("@breatic/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof Shared>();
  return {
    ...shared,
    t: (id: string, values?: Record<string, unknown>): string => {
      rendered.add(id);
      return shared.t(id, values as Parameters<typeof shared.t>[1]);
    },
  };
});

const PACKAGES = resolve(import.meta.dirname, "../../../../..");
const WEB = join(PACKAGES, "web/src");
/** The web modules the reader's screens start from. */
const WEB_ENTRIES = [join(WEB, "index.tsx"), join(WEB, "pages/project/ProjectPage.tsx")];
/** The route table, which lazily imports every page of the app. */
const ROUTE_TABLE = join(WEB, "app/route-imports.ts");
/**
 * Sources read whole, relative to `packages/`: the shared rules, and the
 * server side, whose messages the page shows as the server's answers.
 */
const WHOLE = ["shared/src", "server/src", "domain/src", "core/src"];

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
 * The web source file an import names, if it is one of ours.
 * @param from - The importing file.
 * @param spec - The import specifier.
 * @returns The file, or undefined for a package or a non-source file.
 */
function resolveWebImport(from: string, spec: string): string | undefined {
  const base = spec.startsWith("@web/")
    ? join(WEB, spec.slice("@web/".length))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : undefined;
  if (base === undefined) return undefined;
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base].find(
    (file) => /\.tsx?$/.test(file) && existsSync(file) && statSync(file).isFile(),
  );
}

/**
 * Every web module reachable by import from the entries, the route table left out.
 * @returns Their paths.
 */
function webSources(): string[] {
  const seen = new Set<string>();
  const pending = [...WEB_ENTRIES];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file) || file === ROUTE_TABLE) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolveWebImport(file, match[1] as string);
      if (next !== undefined) pending.push(next);
    }
  }
  return [...seen];
}

/**
 * The message ids a source names: each written out as a string, and every
 * message under a prefix a template string completes at run time.
 * @param text - The source.
 * @returns The ids it names.
 */
function namedMessages(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/['"`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
    if (messages.has(match[1] as string)) ids.push(match[1] as string);
  }
  for (const match of text.matchAll(/`([a-zA-Z][\w-]*(?:\.[\w-]+)*)\.\$\{/g)) {
    const prefix = `${match[1] as string}.`;
    for (const id of messages.keys()) if (id.startsWith(prefix)) ids.push(id);
  }
  return ids;
}

/**
 * Every message id the screens can show.
 * @returns The ids, each once.
 */
function screenMessages(): Set<string> {
  const ids = new Set<string>();
  const read = (file: string): string => readFileSync(file, "utf8");
  for (const file of webSources()) for (const id of namedMessages(read(file))) ids.add(id);
  for (const path of WHOLE) {
    for (const file of sources(join(PACKAGES, path))) for (const id of namedMessages(read(file))) ids.add(id);
  }
  return ids;
}

let guide = "";
beforeAll(() => {
  loadLocales();
  rendered.clear();
  guide = runWithLocale("en", renderProductGuide);
});

describe("what the guide does with each message on the screens", () => {
  const shown = screenMessages();

  it("finds the screens' messages", () => {
    // A reading that finds nothing would pass every check below.
    expect(shown.size).toBeGreaterThan(700);
    expect(rendered.size).toBeGreaterThan(300);
  });

  it("quotes, describes or leaves out every one of them", () => {
    const unplaced = [...shown].filter((id) => !rendered.has(id) && !(id in NOT_QUOTED));
    expect(unplaced).toEqual([]);
  });

  it("lists only messages the screens still show and the guide does not quote", () => {
    const stale = Object.keys(NOT_QUOTED).filter((id) => !shown.has(id) || rendered.has(id));
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
