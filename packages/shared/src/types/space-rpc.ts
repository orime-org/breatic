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

/**
 * Create a new Space. Caller generates the spaceId client-side
 * (uuid v4) per ADR B1.1 - collab uses `set-if-not-exists` semantics
 * so a collision is reported as `CONFLICT` and the client
 * retries with a fresh id.
 */
// Space name length cap shared across create + rename (and the web
// TitleEditable primitive). 80 matches the project-title cap so users
// have a single mental model for "how long can I make a name".
export const SPACE_NAME_MAX_LEN = 80;

export const SpaceCreatePayloadSchema = z.object({
  spaceId: z.string().min(1).max(64),
  type: SpaceTypeSchema,
  name: z.string().min(1).max(SPACE_NAME_MAX_LEN),
});
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

// ── projectMessages entry schema ────────────────────────────────────

/**
 * Single entry in `meta.projectMessages` Y.Array. Per ADR
 * 2026-05-23-project-messages-channel kind enum.
 */
export const ProjectMessageKindSchema = z.enum([
  "missing-node",
  "space-created",
  "space-deleted",
  "space-locked",
  "space-unlocked",
  "space-restored",
  "space-renamed",
]);
export type ProjectMessageKind = z.infer<typeof ProjectMessageKindSchema>;

export const ProjectMessageEntrySchema = z.object({
  id: z.string(),
  kind: ProjectMessageKindSchema,
  /**
   * Q11 v2 - userId (UUID) of the user who triggered this event.
   * Optional because system-emitted entries (e.g. `missing-node`) have
   * no human actor. Frontend renders the display name via
   * `meta.users[actor].name` so a later rename retroactively reflects.
   */
  actor: z.string().optional(),
  /**
   * Q11 v2.1 - pointer into `meta.spaces` for ownership/lookup of
   * non-name metadata (e.g. type for kind icons). The Space's
   * displayed NAME, however, is captured as a snapshot below
   * (`spaceName`) so each entry records the name at the moment the
   * event happened - rename is its own audit event(`space-renamed`
   * kind), the existing entries stay frozen as historical truth.
   * Live-lookup of name was tried in v2 but conflicts with the
   * "events log" semantics.
   */
  spaceId: z.string().optional(),
  /**
   * Snapshot of Space name at event time. For `space-deleted` the
   * spaceId has left `meta.spaces` so this is the only place left
   * to read from; for active kinds (`space-created` / `-locked` /
   * `-unlocked` / `-restored`) it records the name as it was when
   * the event fired, immune to later renames. For `space-renamed`
   * this is the NEW name (post-rename); the pre-rename name lives
   * in `oldSpaceName`.
   */
  spaceName: z.string().optional(),
  /**
   * `space-renamed` only - snapshot of the Space name BEFORE the
   * rename. Paired with `spaceName` (the new name) the frontend
   * renders "{actor} renamed {oldSpaceName} to {spaceName}".
   * Optional because every other kind leaves it empty.
   */
  oldSpaceName: z.string().optional(),
  spaceSnapshot: z.record(z.string(), z.unknown()).optional(),
  /**
   * `space-deleted` only - `true` once a subsequent `space:restore`
   * RPC has successfully un-soft-deleted the Space. The restore
   * handler mutates this field on the original deleted entry in the
   * same `transact` that writes the new `space-restored` entry, so
   * any client looking at the deleted row knows it's already been
   * brought back. Drives the bell sheet's restore button - present
   * & true means render a disabled "restored" badge instead of an
   * actionable Restore. Missing on legacy entries written before
   * this field shipped; treat undefined as "not yet restored" (the
   * restore RPC will refuse the second click via NOT_FOUND, which
   * is still correct - the field just lets the UI prevent the
   * round-trip in the first place).
   */
  restored: z.boolean().optional(),
  message: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int(),
});
export type ProjectMessageEntry = z.infer<typeof ProjectMessageEntrySchema>;
