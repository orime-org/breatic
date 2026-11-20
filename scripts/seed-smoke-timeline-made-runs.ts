// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turn web-animation runs a smoke case made in a Motion Space of its own smoke Project into runs a Timeline made before
 * Motion existed (#1490): migration 0128 stored those with `origin = 'timeline'` on the Timeline's Space, and the grant
 * rows carry the same origin. Reads `{ projectId, timelineSpaceId, executionIds }` on stdin and prints how many rows it
 * moved.
 */
import { text } from 'node:stream/consumers';

// Follow scripts/seed-smoke-account.ts: services load configuration themselves.
// Neither the test nor the agent opens or prints the runtime environment file.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the request, check it names an owned smoke Project, and move its runs.
 * @returns Nothing.
 * @throws {Error} When the input is not UUIDs, the Project is not a smoke fixture, or a run is not that Project's own.
 */
async function main(): Promise<void> {
  await import('../packages/server/src/bootstrap-config.js');
  const core = await import('../packages/core/dist/index.js');
  try {
    const input = JSON.parse(await text(process.stdin)) as { projectId?: unknown; timelineSpaceId?: unknown; executionIds?: unknown };
    const ids = Array.isArray(input.executionIds) ? input.executionIds : [];
    for (const value of [input.projectId, input.timelineSpaceId, ...ids]) {
      if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Expected a Project, a Timeline Space and run UUIDs on stdin');
    }
    if (ids.length === 0) throw new Error('Expected at least one run');
    const projectId = input.projectId as string;
    const timelineSpaceId = input.timelineSpaceId as string;
    const executionIds = ids as string[];
    const [owned] = await core.rawPg`SELECT id FROM projects WHERE id = ${projectId} AND slug LIKE 'smoke-run%'`;
    if (!owned) throw new Error('The requested Project is not a smoke fixture');
    const moved = await core.rawPg.begin(async (tx) => {
      const runs = await tx`
        UPDATE timeline_executions SET origin = 'timeline', space_id = ${timelineSpaceId}
        WHERE id = ANY(${executionIds}::uuid[]) AND project_id = ${projectId}
        RETURNING id`;
      if (runs.length !== executionIds.length) throw new Error('Every run must be this smoke Project\'s own');
      await tx`UPDATE timeline_execution_grants SET execution_origin = 'timeline' WHERE execution_id = ANY(${executionIds}::uuid[])`;
      return runs.length;
    });
    process.stdout.write(`${JSON.stringify({ moved })}\n`);
  } finally { await core.closeDb(); }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Moving the smoke runs failed'); process.exitCode = 1; });
