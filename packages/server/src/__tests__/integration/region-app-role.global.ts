// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The region suite's containers (inner#1955): the shared containers, then a
 * login role granted the way migrate grants it outside the global region.
 * The services connect as that role; fixtures keep the owning role.
 */

import postgres from "postgres";
import { setup as startContainers, teardown } from "@breatic/integration-tests/containers";

const ROLE = "region_app";
const PASSWORD = "region_app";

/**
 * The same address under the services' role.
 * @param url - A database address under the owning role.
 * @returns The address under the services' role.
 */
function asAppRole(url: string): string {
  const parsed = new URL(url);
  parsed.username = ROLE;
  parsed.password = PASSWORD;
  return parsed.toString();
}

/**
 * Start the containers and grant the services' role.
 * @param ctx - Vitest's globalSetup context.
 * @param ctx.provide - Forwards a value to the test workers.
 * @returns Once the role is granted.
 */
export async function setup(ctx: { provide: (key: string, value: string) => void }): Promise<void> {
  const urls: Record<string, string> = {};
  await startContainers({
    provide: (key, value) => {
      urls[key] = value;
      ctx.provide(key, value);
    },
  });
  const owner = postgres(urls.DATABASE_URL!, { max: 1 });
  await owner.unsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  await owner.end({ timeout: 5 });
  const { applyRegionGrants, initCore } = await import("@breatic/core");
  initCore(process.env);
  await applyRegionGrants(ROLE);
  ctx.provide("REGION_APP_DATABASE_URL", asAppRole(urls.DATABASE_URL!));
  ctx.provide("REGION_APP_YJS_DATABASE_URL", asAppRole(urls.YJS_DATABASE_URL!));
}

export { teardown };
