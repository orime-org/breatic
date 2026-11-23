// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfigInput } from "../config/schema.js";
import { fakeUpstream, type FakeUpstream, type Reply, type Seen } from "../media/__tests__/fake-upstream.js";
import { createProvider, type Provider } from "../provider.js";
import { deploymentKeyOf, malformedKeyArb, printableKeyArb, settled, textOf } from "./keys-harness.js";

// Checking a key a user fills in (inner#1953): whether it reaches the upstream, and what balance it may read, each
// upstream asked its own way; the key never appears in what comes back, and a malformed key is refused unsent.

type Upstream = "wavespeed" | "fal" | "sandbase" | "openrouter";
const UPSTREAMS: readonly Upstream[] = ["wavespeed", "fal", "sandbase", "openrouter"];

/** The result of a check, as the design describes it. */
interface Checked {
  connected: boolean;
  balance?: { amount: number; currency: string } | "unsupported" | "forbidden" | "no_cap";
  /** Why a key is not connected. */
  reason?: string;
  /** fal only: whether the key can read the billing events actual costs are read from. */
  costsReadable?: boolean;
}

let fakes: Record<Upstream, FakeUpstream>;

beforeEach(async () => {
  const [wavespeed, fal, sandbase, openrouter] = await Promise.all(UPSTREAMS.map(() => fakeUpstream()));
  fakes = { wavespeed: wavespeed!, fal: fal!, sandbase: sandbase!, openrouter: openrouter! };
});

afterEach(async () => {
  await Promise.all(Object.values(fakes).map((f) => f.close()));
});

/**
 * The shipped upstreams' shape over the fakes: each base url keeps the path the real one has.
 * @returns The raw configuration.
 */
function config(): ProviderConfigInput {
  return {
    upstreams: {
      wavespeed: { kind: "wavespeed", base_url: `${fakes.wavespeed.url}/api/v3`, key_env: "WAVESPEED_API_KEY" },
      fal: { kind: "fal", base_url: fakes.fal.url, billing_url: `${fakes.fal.url}/v1`, key_env: "FAL_KEY" },
      sandbase: { kind: "sandbase", base_url: `${fakes.sandbase.url}/v1`, key_env: "SANDBASE_API_KEY" },
      openrouter: { kind: "openrouter", base_url: `${fakes.openrouter.url}/api/v1`, key_env: "OPENROUTER_API_KEY" },
    },
    media: { models: {} },
  };
}

/**
 * A provider whose deployment has every key, read through a spy.
 * @returns The provider, its check and the spy, cleared of whatever building it read.
 */
function started(): { provider: Provider; checkKey: (upstream: string, key: string) => Promise<Checked>; deploymentKeys: ReturnType<typeof deploymentKeyOf> } {
  const deploymentKeys = deploymentKeyOf({ WAVESPEED_API_KEY: "dep-ws", FAL_KEY: "dep-fal", SANDBASE_API_KEY: "dep-sb", OPENROUTER_API_KEY: "dep-or" });
  const provider = createProvider({ config: config(), keyOf: deploymentKeys, llmMaxRetries: 0, cleanText: (t) => t });
  deploymentKeys.mockClear();
  const check = (provider as unknown as { checkKey?: unknown }).checkKey;
  expect(check, "provider.checkKey").toBeTypeOf("function");
  return { provider, checkKey: (upstream, key) => (check as (u: string, k: string) => Promise<Checked>).call(provider, upstream, key), deploymentKeys };
}

/**
 * The GET requests a fake received on one path.
 * @param upstream - The upstream.
 * @param path - The path.
 * @returns Them, in order.
 */
const gets = (upstream: Upstream, path: string): Seen[] => fakes[upstream].seen.filter((s) => s.method === "GET" && s.path === path);

const OR_KEY = (limit: number | null, remaining: number | null): Reply => ({ status: 200, body: { data: { label: "sk-or-v1-abc...xyz", limit, usage: 2.5, limit_remaining: remaining, is_free_tier: false } } });

describe("checkKey on WaveSpeed", () => {
  it("reads the balance in USD from /api/v3/balance with the key it was given", async () => {
    const { checkKey, deploymentKeys } = started();
    fakes.wavespeed.answer(({ path }) => (path === "/api/v3/balance" ? { status: 200, body: { code: 200, message: "success", data: { balance: 12.34 } } } : undefined));
    expect(await checkKey("wavespeed", "user-ws")).toMatchObject({ connected: true, balance: { amount: 12.34, currency: "USD" } });
    expect(gets("wavespeed", "/api/v3/balance").map((s) => s.authorization)).toEqual(["Bearer user-ws"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("answers connected with a forbidden balance for a key whose role may not read it", async () => {
    const { checkKey } = started();
    fakes.wavespeed.answer(() => ({ status: 403, body: { code: 403, message: "Forbidden" } }));
    expect(await checkKey("wavespeed", "user-ws")).toMatchObject({ connected: true, balance: "forbidden" });
  });

  it("answers not connected, with a reason, for a key it refuses", async () => {
    const { checkKey } = started();
    fakes.wavespeed.answer(() => ({ status: 401, body: { code: 401, message: "Unauthorized" } }));
    const checked = await checkKey("wavespeed", "user-ws");
    expect(checked.connected).toBe(false);
    expect(checked.reason).toEqual(expect.any(String));
  });
});

describe("checkKey on any status", () => {
  it.each([
    [404, { connected: false, reason: "refused" }],
    [408, { connected: false, reason: "unavailable" }],
    [503, { connected: false, reason: "unavailable" }],
    [429, { connected: false, reason: "rate_limited" }],
  ] as const)("answers %i as %o", async (status, expected) => {
    const { checkKey } = started();
    fakes.wavespeed.answer(() => ({ status, body: {} }));
    expect(await checkKey("wavespeed", "user-ws")).toEqual(expected);
  });

  it("refuses an upstream the configuration does not name, sending nothing", async () => {
    const { checkKey } = started();
    await expect(checkKey("nope", "user-key")).rejects.toThrow("provider cannot check keys of upstream nope");
    expect(Object.values(fakes).flatMap((f) => f.seen)).toHaveLength(0);
  });
});

describe("checkKey on fal", () => {
  /**
   * fal answering its balance and its billing events.
   * @param balance - The balance answer.
   * @param events - The billing events answer.
   */
  const falAnswers = (balance: Reply, events: Reply): void =>
    fakes.fal.answer(({ path }) => {
      if (path === "/v1/account/billing") return balance;
      if (path === "/v1/models/billing-events") return events;
      return undefined;
    });

  it("reads credits.current_balance from /v1/account/billing?expand=credits, and probes the billing events actual costs come from", async () => {
    const { checkKey, deploymentKeys } = started();
    falAnswers({ status: 200, body: { username: "u", credits: { current_balance: 12.5, currency: "USD" } } }, { status: 200, body: { billing_events: [] } });
    expect(await checkKey("fal", "user-fal")).toMatchObject({ connected: true, balance: { amount: 12.5, currency: "USD" }, costsReadable: true });
    const balance = gets("fal", "/v1/account/billing");
    expect(balance.map((s) => s.authorization)).toEqual(["Key user-fal"]);
    expect(new URLSearchParams(balance[0]!.query).get("expand")).toBe("credits");
    // The probe asks about a request that does not exist: it costs nothing.
    expect(gets("fal", "/v1/models/billing-events").map((s) => s.authorization)).toEqual(["Key user-fal"]);
    expect(fakes.fal.seen.filter((s) => s.method === "POST")).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("reads a fal balance with no currency as USD, and one with no balance as unsupported", async () => {
    const { checkKey } = started();
    falAnswers({ status: 200, body: { credits: { current_balance: 3 } } }, { status: 200, body: { billing_events: [] } });
    expect(await checkKey("fal", "user-fal")).toMatchObject({ connected: true, balance: { amount: 3, currency: "USD" } });
    // A balance in fal's own currency keeps that currency.
    falAnswers({ status: 200, body: { credits: { current_balance: 3, currency: "EUR" } } }, { status: 200, body: { billing_events: [] } });
    expect(await checkKey("fal", "user-fal")).toMatchObject({ connected: true, balance: { amount: 3, currency: "EUR" } });
    falAnswers({ status: 200, body: { credits: { currency: "EUR" } } }, { status: 200, body: { billing_events: [] } });
    expect(await checkKey("fal", "user-fal")).toMatchObject({ connected: true, balance: "unsupported" });
  });

  it("answers a default API key's 403 on the balance as connected with a forbidden balance, and says when it cannot read costs", async () => {
    const { checkKey } = started();
    falAnswers({ status: 403, body: { detail: "Forbidden" } }, { status: 403, body: { detail: "Forbidden" } });
    expect(await checkKey("fal", "user-fal")).toMatchObject({ connected: true, balance: "forbidden", costsReadable: false });
  });

  it("says nothing about reading costs when the billing probe cannot be answered", async () => {
    const { checkKey } = started();
    falAnswers({ status: 200, body: { username: "u", credits: { current_balance: 1, currency: "USD" } } }, { status: 503, body: {} });
    const checked = await checkKey("fal", "user-fal");
    expect(checked).toMatchObject({ connected: true, balance: { amount: 1, currency: "USD" } });
    expect(checked).not.toHaveProperty("costsReadable");
  });

  it("answers not connected for a key it refuses", async () => {
    const { checkKey } = started();
    falAnswers({ status: 401, body: { detail: "No user found for Key ID and Secret" } }, { status: 401, body: { detail: "No user found for Key ID and Secret" } });
    const checked = await checkKey("fal", "user-fal");
    expect(checked.connected).toBe(false);
    expect(checked.reason).toEqual(expect.any(String));
  });
});

describe("checkKey on SandBase", () => {
  it("reads the balance string from /v1/account/balance as USD", async () => {
    const { checkKey, deploymentKeys } = started();
    fakes.sandbase.answer(({ path }) => (path === "/v1/account/balance" ? { status: 200, body: { balance: "7.25" } } : undefined));
    expect(await checkKey("sandbase", "user-sb")).toMatchObject({ connected: true, balance: { amount: 7.25, currency: "USD" } });
    expect(gets("sandbase", "/v1/account/balance").map((s) => s.authorization)).toEqual(["Bearer user-sb"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("answers not connected for a key it refuses", async () => {
    const { checkKey } = started();
    fakes.sandbase.answer(() => ({ status: 401, body: { error: "invalid api key" } }));
    expect(await checkKey("sandbase", "user-sb")).toMatchObject({ connected: false, reason: expect.any(String) });
  });
});

describe("checkKey on OpenRouter", () => {
  it("reads the key's remaining limit from /api/v1/key", async () => {
    const { checkKey, deploymentKeys } = started();
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/key" ? OR_KEY(10, 7.5) : undefined));
    expect(await checkKey("openrouter", "sk-or-user")).toMatchObject({ connected: true, balance: { amount: 7.5, currency: "USD" } });
    expect(gets("openrouter", "/api/v1/key").map((s) => s.authorization)).toEqual(["Bearer sk-or-user"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("answers a key with no limit as having no cap, never a zero balance", async () => {
    const { checkKey } = started();
    fakes.openrouter.answer(({ path }) => (path === "/api/v1/key" ? OR_KEY(null, null) : undefined));
    expect(await checkKey("openrouter", "sk-or-user")).toMatchObject({ connected: true, balance: "no_cap" });
  });

  it("answers not connected for a key it refuses", async () => {
    const { checkKey } = started();
    fakes.openrouter.answer(() => ({ status: 401, body: { error: { message: "No auth credentials found", code: 401 } } }));
    expect(await checkKey("openrouter", "sk-or-user")).toMatchObject({ connected: false, reason: expect.any(String) });
  });
});

describe("checkKey never hands a key back", () => {
  it("property: whatever an upstream answers, even an echo of the key, the result and any error hold no key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...UPSTREAMS),
        printableKeyArb,
        fc.constantFrom(200, 401, 403, 429, 500, 0),
        async (upstream, key, status) => {
          const { checkKey } = started();
          // The upstream echoes the authorization it received back in its answer, or drops the connection (0).
          fakes[upstream].answer(({ path }) => {
            if (status === 0) return "reset";
            const echo = fakes[upstream].seen.at(-1)?.authorization ?? "";
            return { status, body: { error: { message: `bad ${echo}` }, detail: `bad ${echo}`, message: `bad ${echo}`, path } };
          });
          const outcome = await settled(checkKey(upstream, key));
          expect(fakes[upstream].seen.some((s) => (s.authorization ?? "").includes(key))).toBe(true);
          expect(textOf("error" in outcome ? outcome.error : outcome.answer).includes(key)).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("property: refuses a malformed key with an error that does not hold it, sending nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...UPSTREAMS), malformedKeyArb, async (upstream, key) => {
        const { checkKey } = started();
        const before = fakes[upstream].seen.length;
        const outcome = await settled(checkKey(upstream, key));
        expect("error" in outcome).toBe(true);
        expect(textOf((outcome as { error: unknown }).error).includes(key)).toBe(false);
        expect(fakes[upstream].seen.length).toBe(before);
      }),
      { numRuns: 60 },
    );
  });
});
