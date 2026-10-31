// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fixtures for the transfer-reference suites (inner#1006 §4.6).
 *
 * A "completed transfer grant" is built the way the spec's fixture says:
 * `issueGrant` with `assetSource: 'transfer'`, then `claimFinalize`, then
 * `completeTransferGrant`. Storage is never reached: the suite's R2 endpoint
 * is `https://r2.test.invalid`, so the adapter's `read` is replaced by a stub
 * each test programs.
 */

import crypto from "node:crypto";
import type postgres from "postgres";
import type { Hono } from "hono";
import {
  env,
  getRedis,
  setSession,
  sessionCookieName,
  storageKey,
  getStorageConfig,
  getStorageAdapter,
} from "@breatic/core";
import { uploadGrantRepo } from "@breatic/domain";
import { TRANSFER_SIGNATURE, encodeTransferBody } from "@breatic/shared";

type Sql = ReturnType<typeof postgres>;

/** A signed-in member. */
export interface Member {
  id: string;
  cookie: string;
}

/** A project with two editors, A (the owner) and B. */
export interface Seeded {
  a: Member;
  b: Member;
  studioId: string;
  projectId: string;
}

let seq = 0;

/**
 * A signed-in user.
 * @param sql - Test connection.
 * @param tag - Distinguishes the email.
 * @returns The user and their cookie.
 */
async function member(sql: Sql, tag: string): Promise<Member> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}-${seq++}-${Date.now().toString(36)}@example.com`}, true) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { id: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * A project P with A as owner and B as editor, both signed in.
 * @param sql - Test connection.
 * @returns The two members and the project.
 */
export async function seedProject(sql: Sql): Promise<Seeded> {
  const a = await member(sql, "transfer-a");
  const b = await member(sql, "transfer-b");
  const tag = `transfer-${seq++}-${Date.now().toString(36)}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${a.id}, ${`${tag}-s`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${a.id}, 'admin')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${b.id}, 'guest')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${a.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${a.id}, 'owner', null), (${project!.id}, ${b.id}, 'editor', ${a.id})
  `;
  return { a, b, studioId: studio!.id, projectId: project!.id };
}

/**
 * A conversation of `userId` in `projectId`.
 * @param sql - Test connection.
 * @param userId - Its owner.
 * @param projectId - Its project.
 * @returns The conversation id.
 */
export async function seedConversation(sql: Sql, userId: string, projectId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, title, project_id) VALUES (${userId}, 'transfer', ${projectId}) RETURNING id
  `;
  return row!.id;
}

/**
 * A fresh key in the shape the transfer ticket mints.
 * @returns `transfer/<date>/<ts>_<uuid>.transfer`.
 */
export function transferKey(): string {
  return storageKey({ taskType: "transfer", ext: ".transfer" });
}

/** Where a transfer grant stands. */
export type GrantState = "open" | "finishing" | "completed" | "voided";

/**
 * A transfer grant of `userId` in the given state.
 * @param opts - Owner, project and the size the ticket declared.
 * @param opts.userId - Who asked for the ticket.
 * @param opts.studioId - The project's studio.
 * @param opts.projectId - The project.
 * @param opts.declaredSize - The whole transfer file's size.
 * @param state - Where to leave it.
 * @param key - The storage key to issue it under; a fresh one by default.
 * @returns The grant's storage key.
 */
export async function transferGrant(
  opts: { userId: string; studioId: string; projectId: string; declaredSize: number },
  state: GrantState = "completed",
  key: string = transferKey(),
): Promise<string> {
  await uploadGrantRepo.issueGrant({
    userId: opts.userId,
    studioId: opts.studioId,
    storageKey: key,
    declaredSize: opts.declaredSize,
    expiresAt: new Date(Date.now() + 300_000),
    context: {
      projectId: opts.projectId,
      nodeId: null,
      spaceId: null,
      derived: true,
      filename: "body.transfer",
      assetSource: "transfer",
    },
  });
  if (state === "open") return key;
  await uploadGrantRepo.claimFinalize({ storageKey: key, uploadId: `upload-${crypto.randomUUID()}` });
  if (state === "finishing") return key;
  if (state === "voided") {
    await uploadGrantRepo.voidGrant(key, "unsupported_type");
    return key;
  }
  await uploadGrantRepo.completeTransferGrant(key);
  return key;
}

/**
 * Move a grant's completion `seconds` into the past.
 * @param sql - Test connection.
 * @param key - The grant's key.
 * @param seconds - How long ago it completed.
 * @returns Once written.
 */
export async function completedAgo(sql: Sql, key: string, seconds: number): Promise<void> {
  await sql`
    UPDATE upload_grants SET consumed_at = now() - make_interval(secs => ${seconds}) WHERE storage_key = ${key}
  `;
}

/**
 * The grant row's state columns, timestamps as full-precision text.
 * @param sql - Test connection.
 * @param key - The grant's key.
 * @returns The row's state.
 */
export async function grantRow(
  sql: Sql,
  key: string,
): Promise<{ consumed_at: string | null; voided_at: string | null; asset_id: string | null }> {
  const [row] = await sql<{ consumed_at: string | null; voided_at: string | null; asset_id: string | null }[]>`
    SELECT consumed_at::text AS consumed_at, voided_at::text AS voided_at, asset_id FROM upload_grants WHERE storage_key = ${key}
  `;
  return row!;
}

/**
 * `REF(K)`: the one-time reference key of a transfer.
 * @param key - The transfer's storage key.
 * @returns The Redis key.
 */
export function refKey(key: string): string {
  return `${env.REDIS_KEY_PREFIX}:server:transfer-ref:${key}`;
}

/**
 * `LOCKK(U)`: a user's read lock.
 * @param userId - The user.
 * @returns The Redis key.
 */
export function lockKey(userId: string): string {
  return `${env.REDIS_KEY_PREFIX}:server:transfer-read:${userId}`;
}

/**
 * Every transfer-ref key now in Redis.
 * @returns The keys, sorted.
 */
export async function allRefKeys(): Promise<string[]> {
  return (await getRedis().keys(`${env.REDIS_KEY_PREFIX}:server:transfer-ref:*`)).sort();
}

/** The transfer section of the storage config. */
export function transferConfig(): {
  route_max_bytes: { chat_message: number; canvas_paste: number; node_history_snapshot: number };
  reference_ttl_seconds: number;
  read_lock_seconds: number;
} {
  return getStorageConfig().transfer;
}

/**
 * `ENC(v)`.
 * @param v - The request body.
 * @returns The transfer file's bytes.
 */
export function enc(v: unknown): Uint8Array {
  return encodeTransferBody(JSON.stringify(v));
}

/**
 * The signature line's bytes.
 * @returns `SIG` as bytes.
 */
export function sig(): Uint8Array {
  return new TextEncoder().encode(TRANSFER_SIGNATURE);
}

/**
 * Join byte runs.
 * @param parts - The runs, as bytes or text.
 * @returns One array.
 */
export function bytes(...parts: Array<Uint8Array | string | number[]>): Uint8Array {
  const arrays = parts.map((p) =>
    typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p),
  );
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/** A 1x1 PNG file. */
export const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** What the read stub is asked and how it answers. */
export interface ReadStub {
  /** Every `(key, maxBytes)` the adapter's `read` received, in order. */
  calls: Array<[string, number]>;
  /** How the next calls answer. */
  answer: (key: string, maxBytes: number) => Promise<Uint8Array>;
}

/**
 * Replace the storage adapter's `read` with a stub the test programs.
 * @returns The stub's controls.
 */
export async function installReadStub(): Promise<ReadStub> {
  const adapter = await getStorageAdapter();
  const stub: ReadStub = {
    calls: [],
    answer: async () => {
      throw new Error("read stub not programmed");
    },
  };
  adapter.read = async (key: string, maxBytes: number): Promise<Uint8Array> => {
    stub.calls.push([key, maxBytes]);
    return stub.answer(key, maxBytes);
  };
  return stub;
}

/**
 * Send `{"transfer": key}` (or any raw text) to a route.
 * @param app - The public app.
 * @param path - The route under `/api/v1`.
 * @param cookie - The session cookie, or null for none.
 * @param body - The raw request body.
 * @returns The response.
 */
export async function post(app: Hono, path: string, cookie: string | null, body: string): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      ...(cookie === null ? {} : { Cookie: cookie }),
    },
    body,
  });
}

/**
 * A reference request body.
 * @param key - The transfer's key.
 * @returns `{"transfer":key}`.
 */
export function ref(key: string): string {
  return JSON.stringify({ transfer: key });
}

/**
 * Rows of `node_history` in a project.
 * @param sql - Test connection.
 * @param projectId - The project.
 * @returns How many there are.
 */
export async function historyCount(sql: Sql, projectId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM node_history WHERE project_id = ${projectId}`;
  return Number(row!.n);
}

/** A logger double's methods. */
export type LogSpy = Record<"info" | "warn" | "error" | "debug" | "fatal" | "trace", { mock: { calls: unknown[][] } }>;

/**
 * The log lines with this message, at any level.
 * @param logged - The logger double.
 * @param message - The message.
 * @returns Each line's level and fields, in call order within a level.
 */
export function logLines(logged: LogSpy, message: string): Array<{ level: string; fields: Record<string, unknown> }> {
  const out: Array<{ level: string; fields: Record<string, unknown> }> = [];
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    for (const call of logged[level].mock.calls) {
      if (call[1] === message) out.push({ level, fields: call[0] as Record<string, unknown> });
    }
  }
  return out;
}
