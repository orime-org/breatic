// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — every provider key a model catalog names must be readable at runtime.
 *
 * `resolveActiveProvider` reads a provider's key through the `env` proxy, which
 * answers only for names core's schema declares. A name in providers.yaml that
 * the schema never declared reads as empty however the deployment is
 * configured, so that provider is skipped on every request — no error, no log,
 * just an upstream that never gets chosen.
 *
 * Nothing caught that before: the yaml is valid, the schema is valid, and the
 * two are only wrong about each other.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env, initCore } from "@breatic/core";

import { MODALITIES, getFullModelConfig } from "../model-catalog.js";

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test" });
});

afterAll(() => {
  initCore(process.env);
});

/**
 * Collect every credential var name the live model catalogs declare.
 *
 * Covers both halves of a key pair: a vendor authenticated by access key plus
 * secret names two vars, and either one going undeclared leaves the provider
 * unreachable just the same.
 * @returns Each credential var name, paired with where it was declared.
 */
function declaredProviderKeys(): { name: string; where: string }[] {
  const found: { name: string; where: string }[] = [];
  for (const modality of MODALITIES) {
    for (const [provider, config] of Object.entries(
      getFullModelConfig(modality).providers,
    )) {
      for (const name of [config.api_key_env, config.api_secret_env]) {
        if (name) found.push({ name, where: `${modality}/${provider}` });
      }
    }
  }
  return found;
}

describe("every provider key a catalog names is readable at runtime (#1960)", () => {
  it("declares each of them in core's schema", () => {
    const readable = new Set(Object.keys(env));
    const unreadable = declaredProviderKeys()
      .filter(({ name }) => !readable.has(name))
      .map(({ name, where }) => `${name} (${where})`);

    expect(unreadable).toEqual([]);
  });

  it("finds both halves of a key pair, not just the first", () => {
    // Guards the walk itself: reading only `api_key_env` would leave every
    // secret unchecked and this suite green while half the pair drifts.
    const names = declaredProviderKeys().map((k) => k.name);
    expect(names).toContain("KLINGAI_ACCESS_KEY");
    expect(names).toContain("KLINGAI_SECRET_KEY");
  });
});
