// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `influencerCodeFor(origin)` (inner#2157 design §7.2, §8 first row): the
 * sign-up request's `Origin` is parsed with the WHATWG URL parser, its host
 * name (lower case) is looked up in the influencer table, and the account is
 * recorded under that code only when the host is registered and enabled.
 * Unknown hosts, disabled hosts and requests without a usable `Origin` are
 * recorded under `official`.
 *
 * The table lookup is core's `influencerRepo.findByHost(host)`, answered here
 * from an in-memory table so every property runs without a database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

/** One row as `findByHost` answers it: the code and whether it is enabled. */
interface HostRow {
  code: string;
  enabled: boolean;
}

const table = vi.hoisted(() => ({ rows: new Map<string, HostRow>(), lookups: [] as string[] }));

vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    influencerRepo: {
      findByHost: async (host: string): Promise<HostRow | null> => {
        table.lookups.push(host);
        return table.rows.get(host) ?? null;
      },
    },
  };
});

import { influencerCodeFor } from "@server/modules/auth/influencer-code.js";

beforeEach(() => {
  table.rows.clear();
  table.lookups.length = 0;
});

/** A code in the table's alphabet (`^[a-z0-9-]{1,32}$`), never `official`. */
const codeArb = fc
  .stringMatching(/^[a-z0-9-]{1,32}$/)
  .filter((code) => code !== "official");

describe("influencerCodeFor", () => {
  it("returns the code of a registered, enabled host", async () => {
    table.rows.set("alice.partner.breatic.test", { code: "alice", enabled: true });
    expect(await influencerCodeFor("https://alice.partner.breatic.test")).toBe("alice");
    expect(table.lookups).toEqual(["alice.partner.breatic.test"]);
  });

  it("looks the host up without its scheme or port, as local development sends it", async () => {
    table.rows.set("alice.partner.localhost", { code: "alice", enabled: true });
    expect(await influencerCodeFor("http://alice.partner.localhost:8000")).toBe("alice");
    expect(table.lookups).toEqual(["alice.partner.localhost"]);
  });

  it("looks the host up in lower case", async () => {
    table.rows.set("alice.partner.breatic.test", { code: "alice", enabled: true });
    expect(await influencerCodeFor("https://ALICE.Partner.Breatic.TEST")).toBe("alice");
    expect(table.lookups).toEqual(["alice.partner.breatic.test"]);
  });

  it("returns official for a host the table does not hold", async () => {
    table.rows.set("alice.partner.breatic.test", { code: "alice", enabled: true });
    expect(await influencerCodeFor("https://bob.partner.breatic.test")).toBe("official");
  });

  it("returns official for a registered host that is disabled", async () => {
    table.rows.set("alice.partner.breatic.test", { code: "alice", enabled: false });
    expect(await influencerCodeFor("https://alice.partner.breatic.test")).toBe("official");
  });

  it("returns official for the official site, which has no row of its own", async () => {
    expect(await influencerCodeFor("https://breatic.test")).toBe("official");
  });

  it.each([
    ["no Origin header", undefined],
    ["an empty Origin header", ""],
  ])("returns official for %s and reads nothing", async (_name, origin) => {
    table.rows.set("alice.partner.breatic.test", { code: "alice", enabled: true });
    expect(await influencerCodeFor(origin)).toBe("official");
    expect(table.lookups).toEqual([]);
  });

  it.each([
    ["the opaque origin a sandboxed page sends", "null"],
    ["a value that is not a URL", "alice.partner.breatic.test"],
  ])("returns official for %s", async (_name, origin) => {
    table.rows.set("alice.partner.breatic.test", { code: "alice", enabled: true });
    expect(await influencerCodeFor(origin)).toBe("official");
  });

  it("property: any registered enabled host maps to its code, anything else to official", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.domain(),
        codeArb,
        fc.constantFrom<"enabled" | "disabled" | "unregistered">("enabled", "disabled", "unregistered"),
        fc.constantFrom("https://", "http://"),
        fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
        async (domain, code, state, scheme, port) => {
          table.rows.clear();
          table.lookups.length = 0;
          const host = new URL(`https://${domain}`).hostname;
          if (state !== "unregistered") table.rows.set(host, { code, enabled: state === "enabled" });
          const origin = `${scheme}${domain.toUpperCase()}${port === undefined ? "" : `:${port}`}`;
          const expected = state === "enabled" ? code : "official";
          expect(await influencerCodeFor(origin)).toBe(expected);
          expect(table.lookups).toEqual([host]);
        },
      ),
      { seed: 2157, numRuns: 200 },
    );
  });

  it("property: an Origin whose host differs from every registered host is official", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.domain(), { minLength: 2, maxLength: 6 }), codeArb, async (domains, code) => {
        table.rows.clear();
        const hosts = domains.map((d) => new URL(`https://${d}`).hostname);
        fc.pre(new Set(hosts).size === hosts.length);
        const [asked, ...registered] = hosts;
        for (const host of registered) table.rows.set(host, { code, enabled: true });
        expect(await influencerCodeFor(`https://${asked!}`)).toBe("official");
      }),
      { seed: 2158, numRuns: 100 },
    );
  });
});
