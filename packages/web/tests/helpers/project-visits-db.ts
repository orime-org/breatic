// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Read-only CLI for the current smoke slot's own Project activity. */
import { text } from 'node:stream/consumers';
import type { AccountActivityKind } from '@breatic/shared';

// Follow scripts/seed-smoke-account.ts: services load configuration themselves.
// Neither the test nor the agent opens or prints the runtime environment file.
/** Inspect only the supplied slot-owned fixture, closing its configured pool. @throws {Error} If input, ownership or persistence is invalid. */
async function main(): Promise<void> {
  await import('../../../server/src/bootstrap-config.js');
  const core = await import('../../../core/dist/index.js');
  try {
    const input = JSON.parse(await text(process.stdin)) as { accountId?: unknown; projectId?: unknown; visitId?: unknown };
    for (const value of [input.accountId, input.projectId, input.visitId]) {
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Expected owned account, Project and visit UUIDs on stdin');
    }
    const [owned] = await core.rawPg`SELECT id FROM projects WHERE id = ${input.projectId as string} AND created_by_user_id = ${input.accountId as string} AND slug LIKE 'smoke-run%'`;
    if (!owned) throw new Error('The requested Project is not an owned smoke fixture');
    const events = await core.rawPg<Array<{ kind: AccountActivityKind; visit_id: string | null; occurred_at: string }>>`
    SELECT kind, visit_id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
    FROM account_activity_events WHERE user_id = ${input.accountId as string} AND project_id = ${input.projectId as string} AND deleted_at IS NULL
    ORDER BY occurred_at, id`;
    if (events.filter((event) => event.visit_id === input.visitId).length !== 1) throw new Error('The original visit must have exactly one persisted event');
    process.stdout.write(`${JSON.stringify({ events })}\n`);
  } finally { await core.closeDb(); }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Owned activity inspection failed'); process.exitCode = 1; });
