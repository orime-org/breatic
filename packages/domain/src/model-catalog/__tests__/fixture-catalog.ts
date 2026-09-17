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
 * A `node:fs` that answers for this fixture and nothing else.
 * @param fixture - The catalog to serve.
 * @returns The three calls the catalog loader makes.
 */
function fsDouble(fixture: FixtureCatalog): Record<string, unknown> {
  const bucketOf = (path: string): string | undefined =>
    Object.keys(fixture.buckets).find((bucket) => new RegExp(`/${bucket}(/|$)`).test(path));
  return {
    readdirSync: (path: string): string[] => {
      // The loader reads a failed directory listing as "no such modality",
      // which is the right answer for the modalities a fixture leaves out.
      if (!bucketOf(String(path))) throw new Error("no such modality");
      return ["fixture.yaml", "providers.yaml"];
    },
    existsSync: (path: string): boolean =>
      String(path).endsWith("modes.yaml") || bucketOf(String(path)) !== undefined,
    readFileSync: (path: string): string => {
      const at = String(path);
      if (at.endsWith("modes.yaml")) return fixture.modes;
      if (at.endsWith("providers.yaml")) return PROVIDERS;
      return fixture.buckets[bucketOf(at) ?? ""] ?? "";
    },
  };
}

/**
 * Mount this catalog, so every module imported after it reads it.
 * @param fixture - The catalog to serve.
 */
export async function useFixtureCatalog(fixture: FixtureCatalog): Promise<void> {
  vi.resetModules();
  vi.doMock("node:fs", () => fsDouble(fixture));
  const env = await import("./catalog-env.js");
  env.useFullCatalog();
}

/** Hand the real catalog and the process's own environment back. */
export async function restoreRealCatalog(): Promise<void> {
  vi.doUnmock("node:fs");
  vi.resetModules();
  const env = await import("./catalog-env.js");
  env.restoreProcessEnv();
}
