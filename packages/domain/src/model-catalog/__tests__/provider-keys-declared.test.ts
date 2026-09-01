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

/**
 * Names that providers.yaml uses and core's schema deliberately does not
 * declare yet. An entry here needs a reason, so the list cannot quietly become
 * a parking lot for the very drift this case exists to catch.
 */
const UNDECLARED_ON_PURPOSE: ReadonlyMap<string, string> = new Map([
  [
    "KLING_ACCESS_KEY",
    // Not a missing definition — a name mismatch. The schema and both env
    // templates carry KLINGAI_ACCESS_KEY / KLINGAI_SECRET_KEY, and
    // config/models/video/providers.yaml asks for KLING_ACCESS_KEY. Declaring
    // this name too would leave two spellings live with one of them ignored,
    // so the fix is to settle on one spelling. Tracked as #1912.
    "spelled KLINGAI_* in the schema and in both env templates (#1912)",
  ],
]);

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test" });
});

afterAll(() => {
  initCore(process.env);
});

/**
 * Collect every `api_key_env` name the live model catalogs declare.
 * @returns Each provider key name, paired with where it was declared.
 */
function declaredProviderKeys(): { name: string; where: string }[] {
  const found: { name: string; where: string }[] = [];
  for (const modality of MODALITIES) {
    for (const [provider, config] of Object.entries(
      getFullModelConfig(modality).providers,
    )) {
      if (config.api_key_env) {
        found.push({ name: config.api_key_env, where: `${modality}/${provider}` });
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
      .filter(({ name }) => !UNDECLARED_ON_PURPOSE.has(name))
      .map(({ name, where }) => `${name} (${where})`);

    expect(unreadable).toEqual([]);
  });

  it("keeps the exception list to names the catalogs still ask for", () => {
    // An entry that no catalog names any more is stale: it would keep an
    // exception alive for a problem that no longer exists.
    const asked = new Set(declaredProviderKeys().map((k) => k.name));
    for (const name of UNDECLARED_ON_PURPOSE.keys()) {
      expect(asked.has(name)).toBe(true);
    }
  });
});
