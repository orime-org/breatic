/**
 * Client ↔ Collab stateless RPC for Space lifecycle.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz (breatic-inner-design):
 * Space create / delete / lock / unlock / restore are no longer routed
 * through the server REST API. The client sends a stateless message
 * over the live Hocuspocus connection on the project's meta doc and
 * the collab process performs the privileged write after validating
 * the caller's role.
 *
 * Wire format:
 *
 *   Request   { id, type: 'space:xxx', payload }     — client → collab
 *   Response  { id, ok: true,  result? }             — collab → client (success)
 *             { id, ok: false, error: { code, message } }   (failure)
 *
 *   - `id` is a caller-generated correlation id (nanoid). The collab
 *     reply echoes it back so concurrent in-flight RPCs can be
 *     demultiplexed by the client.
 *   - `type` namespace is `space:*` and `messages:*`; further methods
 *     join here without bumping a version.
 *
 * Authz at collab (per ADR §B2.5 permissions matrix):
 *
 *   - `space:create`        — caller role ≥ edit
 *   - `space:delete`        — caller role ≥ edit
 *   - `space:lock` / unlock — caller role ≥ edit
 *   - `space:restore`       — caller role = owner
 *   - `messages:clear`      — caller role = owner
 */
import { z } from "zod";

import { SpaceTypeSchema } from "./space.js";

// ── Common ──────────────────────────────────────────────────────────

/**
 * Caller-generated correlation id. We accept any non-empty string up
 * to a sane upper bound; nanoid v5 default is 21 chars so 64 is
 * generous without enabling abuse.
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
 * (nanoid) per ADR B1.1 — collab uses `set-if-not-exists` semantics
 * so a nanoid collision is reported as `CONFLICT` and the client
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
 * Rename an existing Space's name. Caller role ≥ edit. Refuses with
 * `FORBIDDEN` if the Space is locked (per design — locked Spaces
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
 * Owner-only clear of `meta.projectMessages` entries.
 *
 * - `ids` clears specific entries by id
 * - `olderThanMs` clears entries with `createdAt < olderThanMs`
 * - `all` clears the whole array
 *
 * Exactly one of the three must be set (Zod refine below).
 */
export const MessagesClearPayloadSchema = z
  .object({
    ids: z.array(z.string()).optional(),
    olderThanMs: z.number().int().nonnegative().optional(),
    all: z.literal(true).optional(),
  })
  .refine(
    (v) =>
      [v.ids !== undefined, v.olderThanMs !== undefined, v.all !== undefined]
        .filter(Boolean).length === 1,
    {
      message: "Exactly one of ids / olderThanMs / all must be set",
    },
  );
export type MessagesClearPayload = z.infer<typeof MessagesClearPayloadSchema>;

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
    type: z.literal("messages:clear"),
    payload: MessagesClearPayloadSchema,
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
]);
export type ProjectMessageKind = z.infer<typeof ProjectMessageKindSchema>;

export const ProjectMessageEntrySchema = z.object({
  id: z.string(),
  kind: ProjectMessageKindSchema,
  actor: z.string().optional(),
  spaceId: z.string().optional(),
  spaceName: z.string().optional(),
  message: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int(),
});
export type ProjectMessageEntry = z.infer<typeof ProjectMessageEntrySchema>;
