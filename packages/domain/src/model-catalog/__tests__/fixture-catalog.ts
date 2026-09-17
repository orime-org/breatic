// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Give one test a catalog it wrote itself, in place of the repository's (#269).
 *
 * Why it exists: once the answers come off the declarations, "did this read
 * the declaration or the table beside it" cannot be asked on the real catalog
 * -- the migration wrote that table from those declarations, so the two agree
 * row for row and mutating either side turns nothing red. Only a catalog where
 * they deliberately disagree can answer.
 *
 * How to use it: call `useFixtureCatalog`, then `await import(...)` the module
 * under test -- it resets the module registry and replaces `node:fs`, so
 * anything imported before it still holds the real catalog. Undo it with
 * `restoreRealCatalog`.
 */

import { vi } from "vitest";

/** One temporary catalog: the mode declarations, plus one yaml per modality. */
export interface FixtureCatalog {
  /** The whole of `config/models/modes.yaml`. */
  readonly modes: string;
  /** Modality directory name → the whole of the one model yaml it serves. */
  readonly buckets: Readonly<Record<string, string>>;
  /**
   * Skill name → the whole of its `SKILL.md`, for a test driving the prompt
   * these declarations are injected into.
   */
  readonly skills?: Readonly<Record<string, string>>;
}

/**
 * The provider connection every fixture directory shares.
 *
 * The variable name is one the real catalog uses: `useFullCatalog` sets every
 * `api_key_env` it reads to a non-empty value, and that goes through core's
 * schema, which drops a name it does not know -- leaving every model
 * unavailable and the catalog empty again.
 */
const PROVIDERS = [
  "wavespeed:",
  '  base_url: "https://example.invalid"',
  "  api_key_env: WAVESPEED_API_KEY",
].join("\n");

/**
 * The catalog currently mounted, read afresh on every call.
 *
 * Held here rather than closed over, so a test can revise it without mounting
 * again -- mounting resets the module registry, which would hand every cache
 * back empty and hide whatever the revision was meant to show.
 */
let mounted: FixtureCatalog = { modes: "", buckets: {} };

/**
 * A `node:fs` that answers for the mounted fixture and nothing else.
 * @returns The calls the catalog and skill loaders make.
 */
function fsDouble(): Record<string, unknown> {
  const fixture = (): FixtureCatalog => mounted;
  const skills = (): Readonly<Record<string, string>> => fixture().skills ?? {};
  const bucketOf = (path: string): string | undefined =>
    Object.keys(fixture().buckets).find((bucket) => new RegExp(`/${bucket}(/|$)`).test(path));
  const skillOf = (path: string): string | undefined =>
    Object.keys(skills()).find((name) => new RegExp(`/skills/${name}(/|$)`).test(path));
  const isSkillsDir = (path: string): boolean => /\/skills$/.test(path);
  return {
    readdirSync: (path: string): string[] => {
      if (isSkillsDir(String(path))) return Object.keys(skills());
      // The loader reads a failed directory listing as "no such modality",
      // which is the right answer for the modalities a fixture leaves out.
      if (!bucketOf(String(path))) throw new Error("no such modality");
      return ["fixture.yaml", "providers.yaml"];
    },
    statSync: (path: string): { isDirectory: () => boolean } => ({
      isDirectory: () => !String(path).endsWith(".md") && !String(path).endsWith(".json"),
    }),
    existsSync: (path: string): boolean => {
      const at = String(path);
      if (at.endsWith("metadata.json")) return false;
      if (isSkillsDir(at)) return Object.keys(skills()).length > 0;
      if (skillOf(at)) return at.endsWith("SKILL.md") || !at.includes(".");
      return at.endsWith("modes.yaml") || bucketOf(at) !== undefined;
    },
    readFileSync: (path: string): string => {
      const at = String(path);
      if (at.endsWith("modes.yaml")) return fixture().modes;
      if (at.endsWith("providers.yaml")) return PROVIDERS;
      const skill = skillOf(at);
      if (skill !== undefined && at.endsWith("SKILL.md")) return skills()[skill] ?? "";
      return fixture().buckets[bucketOf(at) ?? ""] ?? "";
    },
  };
}

/**
 * Mount this catalog, so every module imported after it reads it.
 * @param fixture - The catalog to serve.
 */
export async function useFixtureCatalog(fixture: FixtureCatalog): Promise<void> {
  mounted = fixture;
  vi.resetModules();
  vi.doMock("node:fs", () => fsDouble());
  const env = await import("./catalog-env.js");
  env.useFullCatalog();
}

/**
 * Change what the mounted catalog says, leaving every module where it is.
 *
 * For asking whether the reset the catalog offers really hands back every
 * answer it carries: mounting again would reset the module registry and empty
 * every cache, which answers yes whatever the reset does.
 * @param revision - The parts of the catalog to replace.
 */
export function reviseFixtureCatalog(revision: Partial<FixtureCatalog>): void {
  mounted = { ...mounted, ...revision };
}

/** Hand the real catalog and the process's own environment back. */
export async function restoreRealCatalog(): Promise<void> {
  vi.doUnmock("node:fs");
  vi.resetModules();
  const env = await import("./catalog-env.js");
  env.restoreProcessEnv();
}
