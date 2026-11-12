// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

import type * as NodeFs from "node:fs";
import { vi } from "vitest";

/** One temporary catalog: the mode declarations, plus one yaml per modality. */
export interface FixtureCatalog {
  /** The whole of `config/models/modes.yaml`. */
  readonly modes: string;
  /** Modality directory name → the whole of the one model yaml it serves. */
  readonly buckets: Readonly<Record<string, string>>;
}

/**
 * The catalog currently mounted, read afresh on every call.
 *
 * Held here rather than closed over, so a test can revise it without mounting
 * again -- mounting resets the module registry, which would hand every cache
 * back empty and hide whatever the revision was meant to show.
 */
let mounted: FixtureCatalog = { modes: "", buckets: {} };

/**
 * A `node:fs` that answers for the mounted fixture below `config/models`, and reads everything else from disk.
 * @param real - The real module.
 * @returns The calls the catalog loaders make.
 */
function fsDouble(real: typeof NodeFs): Record<string, unknown> {
  const fixture = (): FixtureCatalog => mounted;
  const ofProvider = (path: unknown): boolean => !/\/config\/models(\/|$)/.test(String(path));
  const bucketOf = (path: string): string | undefined =>
    Object.keys(fixture().buckets).find((bucket) => new RegExp(`/${bucket}(/|$)`).test(path));
  return {
    readdirSync: (path: string): string[] => {
      if (ofProvider(path)) return real.readdirSync(path);
      // The loader reads a failed directory listing as "no such modality",
      // which is the right answer for the modalities a fixture leaves out.
      if (!bucketOf(String(path))) throw new Error("no such modality");
      return ["fixture.yaml"];
    },
    statSync: (path: string): { isDirectory: () => boolean } => ({
      isDirectory: () => !String(path).endsWith(".md") && !String(path).endsWith(".json"),
    }),
    existsSync: (path: string): boolean => {
      if (ofProvider(path)) return real.existsSync(path);
      const at = String(path);
      return at.endsWith("modes.yaml") || bucketOf(at) !== undefined;
    },
    readFileSync: (path: string): string => {
      if (ofProvider(path)) return real.readFileSync(path, "utf8");
      const at = String(path);
      if (at.endsWith("modes.yaml")) return fixture().modes;
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
  vi.doMock("node:fs", async (importOriginal) => fsDouble(await importOriginal<typeof NodeFs>()));
  const env = await import("./catalog-env.js");
  env.useEnvWithKeys(env.allProviderKeyNames());
  // A fixture's models are bound nowhere in provider's configuration: they are served here by one configured
  // upstream and priced at nothing, which is what the questions these fixtures ask need of them.
  const { initProvider, provider } = await import("../../provider/instance.js");
  const real = provider();
  const bound = (model: string): boolean => real.config.models[model] !== undefined;
  initProvider({
    ...real,
    availability: (model) => (bound(model) ? real.availability(model) : FIXTURE_AVAILABILITY),
    pricingRules: (model) => (bound(model) ? real.pricingRules(model) : { model, upstreams: [] }),
    estimate: async (model, input, route) => (bound(model) ? real.estimate(model, input, route) : null),
  });
  const catalog = await import("../model-catalog.js");
  catalog.resetModelCatalog();
  if (catalog.getModelCatalog().total === 0) throw new Error("useFixtureCatalog: the mounted fixture lists no model");
}

/** How a fixture's model is served: by one upstream whose key is set. */
const FIXTURE_AVAILABILITY = { upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] };

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
