// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Client ↔ Collab stateless RPC for Space lifecycle.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz:
 * Space create / delete / lock / unlock / restore are no longer routed
 * through the server REST API. The client sends a stateless message
 * over the live Hocuspocus connection on the project's meta doc and
 * the collab process performs the privileged write after validating
 * the caller's role.
 *
 * Wire format:
 *
 *   Request   { id, type: 'space:xxx', payload }     - client → collab
 *   Response  { id, ok: true,  result? }             - collab → client (success)
 *             { id, ok: false, error: { code, message } }   (failure)
 *
 *   - `id` is a caller-generated correlation id (uuid v4). The collab
 *     reply echoes it back so concurrent in-flight RPCs can be
 *     demultiplexed by the client.
 *   - `type` namespace is `space:*` and `messages:*`; further methods
 *     join here without bumping a version.
 *
 * Authz at collab (per ADR §B2.5 permissions matrix):
 *
 *   - `space:create`        - caller role ≥ editor
 *   - `space:delete`        - caller role ≥ editor
 *   - `space:lock` / unlock - caller role ≥ editor
 *   - `space:restore`       - caller role = owner
 */
import { z } from "zod";

import { SpaceTypeSchema } from "@shared/types/space.js";

// ── Common ──────────────────────────────────────────────────────────

/**
 * Caller-generated correlation id. We accept any non-empty string up
 * to a sane upper bound; a uuid is 36 chars so 64 is generous
 * without enabling abuse.
 */
const RpcIdSchema = z.string().min(1).max(64);

/**
 * Reasons a collab RPC can refuse. Stable codes the frontend can
 * branch on for UX (e.g. "show retry vs. show 'not authorized'").
 */
export const SpaceRpcErrorCodeSchema = z.enum([
  "FORBIDDEN", // caller role insufficient
  "NOT_FOUND", // spaceId not present in meta.spaces
  "CONFLICT", // create with spaceId that already exists
  "INVALID_INPUT", // Zod parse failed at the collab end
  "INTERNAL", // unexpected error
]);
export type SpaceRpcErrorCode = z.infer<typeof SpaceRpcErrorCodeSchema>;

// ── Request payloads ────────────────────────────────────────────────

// Space name length cap shared across create + rename (and the web
// TitleEditable primitive). 80 matches the project-title cap so users
// have a single mental model for "how long can I make a name".
export const SPACE_NAME_MAX_LEN = 80;

/**
 * Create a new Space. **The server mints the id** — the caller does not
 * name the Space it is creating.
 *
 * A client-chosen id used to be accepted, and it let a client re-submit
 * the id of a Space that had been deleted: the "is this id taken" check
 * reads `meta.spaces`, and a deleted Space is no longer there, so it
 * passed. The client now sends `claimToken` instead, which answers a
 * different question — "which of my machines asked for this?" — so the
 * machine that created a Space can open it when the entry is broadcast
 * back. The server stores the token and echoes it, and never parses it.
 *
 * Strict on purpose: a leftover `spaceId` must be refused outright, not
 * silently dropped, or the old path stays open behind an ignored field.
 */
export const SpaceCreatePayloadSchema = z
  .object({
    type: SpaceTypeSchema,
    name: z.string().min(1).max(SPACE_NAME_MAX_LEN),
    claimToken: z.uuidv4(),
  })
  .strict();
export type SpaceCreatePayload = z.infer<typeof SpaceCreatePayloadSchema>;

/**
 * Rename an existing Space's name. Caller role ≥ editor. Refuses with
 * `FORBIDDEN` if the Space is locked (per design - locked Spaces
 * cannot have their metadata mutated until unlocked).
 */
export const SpaceRenamePayloadSchema = z.object({
  spaceId: z.string().min(1).max(64),
  name: z.string().min(1).max(SPACE_NAME_MAX_LEN),
});
export type SpaceRenamePayload = z.infer<typeof SpaceRenamePayloadSchema>;

export const SpaceDeletePayloadSchema = z.object({
  spaceId: z.string().min(1).max(64),
});
export type SpaceDeletePayload = z.infer<typeof SpaceDeletePayloadSchema>;

export const SpaceLockPayloadSchema = z.object({
  spaceId: z.string().min(1).max(64),
  locked: z.boolean(),
});
export type SpaceLockPayload = z.infer<typeof SpaceLockPayloadSchema>;

export const SpaceRestorePayloadSchema = z.object({
  spaceId: z.string().min(1).max(64),
});
export type SpaceRestorePayload = z.infer<typeof SpaceRestorePayloadSchema>;

/**
 * Open or close a Space in the caller's own tab bar.
 *
 * The open-tab list lives in the meta doc under `perUser`, and it used to
 * be the one thing a client wrote there directly. That single exception
 * is why the write gate had to understand which field an incoming frame
 * touched — and a gate that must enumerate the framework's internal
 * message types fails open when it misses one. With tabs behind an RPC
 * the rule is flat: a client never writes the meta doc, and its
 * connection to that doc is simply read-only.
 *
 * Strict on purpose: **whose** tab bar changes comes from the
 * authenticated connection, never from the body. Refusing a `userId`
 * field outright means "change someone else's tabs" cannot be expressed.
 */
export const TabPayloadSchema = z
  .object({
    spaceId: z.string().min(1).max(64),
  })
  .strict();
export type TabPayload = z.infer<typeof TabPayloadSchema>;

// ── Request envelope (tagged union) ─────────────────────────────────

export const SpaceRpcRequestSchema = z.discriminatedUnion("type", [
  z.object({
    id: RpcIdSchema,
    type: z.literal("space:create"),
    payload: SpaceCreatePayloadSchema,
  }),
  z.object({
    id: RpcIdSchema,
    type: z.literal("space:delete"),
    payload: SpaceDeletePayloadSchema,
  }),
  z.object({
    id: RpcIdSchema,
    type: z.literal("space:lock"),
    payload: SpaceLockPayloadSchema,
  }),
  z.object({
    id: RpcIdSchema,
    type: z.literal("space:rename"),
    payload: SpaceRenamePayloadSchema,
  }),
  z.object({
    id: RpcIdSchema,
    type: z.literal("space:restore"),
    payload: SpaceRestorePayloadSchema,
  }),
  z.object({
    id: RpcIdSchema,
    type: z.literal("tab:open"),
    payload: TabPayloadSchema,
  }),
  z.object({
    id: RpcIdSchema,
    type: z.literal("tab:close"),
    payload: TabPayloadSchema,
  }),
]);
export type SpaceRpcRequest = z.infer<typeof SpaceRpcRequestSchema>;

// ── Response envelope ────────────────────────────────────────────────

export const SpaceRpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: RpcIdSchema,
    ok: z.literal(true),
    /** `space:create` returns the canonical entry; others return undefined. */
    result: z
      .object({
        spaceId: z.string(),
        type: SpaceTypeSchema,
        name: z.string(),
      })
      .optional(),
  }),
  z.object({
    id: RpcIdSchema,
    ok: z.literal(false),
    error: z.object({
      code: SpaceRpcErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);
export type SpaceRpcResponse = z.infer<typeof SpaceRpcResponseSchema>;

