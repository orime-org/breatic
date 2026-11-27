// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The influencers repository (inner#2157 design 7.1), shared by server and
 * collab: `findByHost` answers sign-up attribution (code and whether it is
 * enabled), `listHosts` feeds the trusted-origin check and keeps disabled
 * hosts in it (their existing users keep using the site), `insertInfluencer`
 * registers one, and `setInfluencerDisabled` flips `disabled_at` without
 * deleting the row.
 *
 * Runs against the testcontainer Postgres started by @breatic/integration-tests/containers.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { initCore, influencerRepo } from "@breatic/core";

let sql: ReturnType<typeof postgres>;
const created: string[] = [];

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "influencer-repo-test" } });
});

afterAll(async () => {
  if (created.length > 0) await sql`DELETE FROM influencers WHERE code = ANY(${created})`;
  await sql?.end({ timeout: 3 });
});

/**
 * Register one influencer with a unique code and host.
 * @param label - Readable part of the code.
 * @returns Its code and host.
 */
async function register(label: string): Promise<{ code: string; host: string }> {
  const code = `${label}-${randomUUID().slice(0, 8)}`;
  const host = `${code}.partner.breatic.test`;
  await influencerRepo.insertInfluencer({ code, host });
  created.push(code);
  return { code, host };
}

describe("influencer repository", () => {
  it("finds a registered host as an enabled influencer", async () => {
    const { code, host } = await register("alice");

    expect(await influencerRepo.findByHost(host)).toEqual({ code, enabled: true });
  });

  it("finds nothing for a host that was never registered", async () => {
    expect(await influencerRepo.findByHost(`nobody-${randomUUID().slice(0, 8)}.partner.breatic.test`)).toBeNull();
  });

  it("stores the row with its host and no disabled_at", async () => {
    const { code, host } = await register("stored");

    const rows = await sql`SELECT code, host, disabled_at FROM influencers WHERE code = ${code}`;
    expect(rows).toEqual([{ code, host, disabled_at: null }]);
  });

  it("reports a disabled influencer as not enabled, with the time it was disabled", async () => {
    const { code, host } = await register("paused");
    const at = new Date("2026-11-26T08:00:00.000Z");

    await influencerRepo.setInfluencerDisabled(code, at);

    expect(await influencerRepo.findByHost(host)).toEqual({ code, enabled: false });
    const rows = await sql`SELECT disabled_at FROM influencers WHERE code = ${code}`;
    expect(rows).toEqual([{ disabled_at: at }]);
  });

  it("enables it again by clearing disabled_at", async () => {
    const { code, host } = await register("back");
    await influencerRepo.setInfluencerDisabled(code, new Date("2026-11-26T08:00:00.000Z"));

    await influencerRepo.setInfluencerDisabled(code, null);

    expect(await influencerRepo.findByHost(host)).toEqual({ code, enabled: true });
    const rows = await sql`SELECT disabled_at FROM influencers WHERE code = ${code}`;
    expect(rows).toEqual([{ disabled_at: null }]);
  });

  it("lists every registered host, the disabled ones included", async () => {
    const enabled = await register("listed");
    const disabled = await register("listed-off");
    await influencerRepo.setInfluencerDisabled(disabled.code, new Date("2026-11-26T08:00:00.000Z"));

    const hosts = await influencerRepo.listHosts();

    expect(hosts.filter((host) => host === enabled.host || host === disabled.host).sort()).toEqual(
      [enabled.host, disabled.host].sort(),
    );
  });

  it("never lists the official row, which has no host", async () => {
    const hosts = await influencerRepo.listHosts();
    const [{ registered }] = (await sql<{ registered: number }[]>`
      SELECT count(*)::int AS registered FROM influencers WHERE host IS NOT NULL`) as unknown as [{ registered: number }];

    expect(hosts.length).toBe(registered);
    expect(hosts.every((host) => typeof host === "string" && host.length > 0)).toBe(true);
  });

  it("keeps a disabled influencer's code and host taken", async () => {
    const { code, host } = await register("held");
    await influencerRepo.setInfluencerDisabled(code, new Date("2026-11-26T08:00:00.000Z"));

    expect(await influencerRepo.findByHost(host)).toEqual({ code, enabled: false });
    await expect(sql`INSERT INTO influencers(code, host) VALUES (${`${code}-x`}, ${host})`).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`INSERT INTO influencers(code, host) VALUES (${code}, ${`other-${randomUUID().slice(0, 8)}.partner.breatic.test`})`,
    ).rejects.toMatchObject({ code: "23505" });
  });
});
