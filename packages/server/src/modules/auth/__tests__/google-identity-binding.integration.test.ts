// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { initCore } from '@breatic/core';
import { linkGoogleIdentity } from '../user.repo.js';

initCore(process.env);
let sql: ReturnType<typeof postgres>;
const created: string[] = [];

beforeAll(() => {
  sql = postgres(inject('DATABASE_URL'), { max: 2, prepare: false });
});
afterEach(async () => {
  for (const id of created.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
  }
});
afterAll(async () => { await sql?.end({ timeout: 5 }); });

/** Create an isolated account whose Google identity is not yet linked. */
async function account(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, membership_tier)
    VALUES (${`google-binding-${randomUUID()}@example.test`}, 'base') RETURNING id
  `;
  created.push(row!.id);
  return row!.id;
}

describe('Google identity binding with real PostgreSQL', () => {
  it('allows exactly one of two competing Google subjects', async () => {
    const id = await account();
    const first = randomUUID();
    const second = randomUUID();
    const results = await Promise.all([linkGoogleIdentity(id, first), linkGoogleIdentity(id, second)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [stored] = await sql<{ google_id: string }[]>`SELECT google_id FROM users WHERE id = ${id}`;
    expect(stored!.google_id).toBe(results.find(Boolean)!.googleId);
  });

  it('permits the same subject to complete an already matching link', async () => {
    const id = await account();
    const subject = randomUUID();
    expect((await linkGoogleIdentity(id, subject))?.googleId).toBe(subject);
    expect((await linkGoogleIdentity(id, subject))?.googleId).toBe(subject);
  });

  it('does not bind an account deleted after the email lookup', async () => {
    const id = await account();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await linkGoogleIdentity(id, randomUUID())).toBeNull();
    const [stored] = await sql<{ google_id: string | null }[]>`SELECT google_id FROM users WHERE id = ${id}`;
    expect(stored!.google_id).toBeNull();
  });
});
