// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared API request schemas.
 *
 * These Zod schemas define the contract between frontend and backend.
 * Both sides import from here to ensure type consistency.
 *
 * Convention: schema name = `{resource}{Action}Schema`
 * Inferred type: `{Resource}{Action}Input`
 */

import { z } from "zod";

import { SpaceTypeSchema } from "@shared/types/space.js";

// ── Auth ─────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Slug-format rule for a studio URL handle (the `/studio/{slug}` segment).
 *
 * Lowercase ASCII; must start with a letter; hyphen-separated alnum
 * segments only (no leading/trailing/double hyphen). Length 6–39 so it
 * fits the `studios.slug varchar(40)` column with margin. Shared so the
 * frontend slug-setup input validates identically to the server.
 */
export const SLUG_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Slugs nobody may claim, because the product needs the name for itself or
 * the word would let a studio impersonate the platform.
 *
 * A studio slug is a namespace claim — it becomes `/studio/{slug}`, and for a
 * personal studio it doubles as the user's `@handle` — so this cannot be a
 * frontend courtesy: a request sent straight to the API has to be refused too.
 * It is enforced on the internal `studioSlug` fragment that every write path
 * validates against, rather than in each service where a new path could
 * forget it.
 *
 * Contents are a product/legal matter and belong to whoever owns naming
 * policy; this is the mechanism plus the list as it stood. Note that entries
 * shorter than the 6-character minimum can never reach this check — the length
 * rule refuses them first — so they are redundant here.
 */
export const RESERVED_STUDIO_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "www",
  "studio",
  "project",
  "collection",
  "breatic",
  "orime",
  "login",
  "settings",
]);

/**
 * Studio slug length bounds: long enough to be a meaningful handle, short
 * enough to fit `studios.slug varchar(40)` with margin. Exported so the
 * frontend's live input hint counts to the same numbers the server enforces.
 */
export const STUDIO_SLUG_BOUNDS = { min: 6, max: 39 } as const;

/**
 * The one studio-slug rule: character shape, length, and reserved words.
 *
 * Every schema that accepts a slug composes this, so the three write paths
 * (personal-studio setup, team-studio creation, studio rename) cannot drift
 * apart — and a fourth added later inherits the rule by construction. Failure
 * messages are stable codes the frontend maps to localised copy.
 */
const studioSlug = z
  .string()
  .min(STUDIO_SLUG_BOUNDS.min)
  .max(STUDIO_SLUG_BOUNDS.max)
  .regex(SLUG_REGEX, "slug_invalid_format")
  .refine((value) => !RESERVED_STUDIO_SLUGS.has(value), "slug_reserved");

/**
 * `POST /auth/setup-studio` body — the second registration step. The
 * authenticated (but studio-less) user picks the slug for their personal
 * studio; the server validates it here and re-checks uniqueness against
 * `studios.slug` before creating the studio.
 */
export const setupStudioSchema = z.object({
  slug: studioSlug,
});
export type SetupStudioInput = z.infer<typeof setupStudioSchema>;

/**
 * `POST /api/v1/studios` body — create a team studio. The authenticated user
 * picks a display name + a globally-unique slug (handle); the server validates
 * it here and enforces uniqueness via the `studios_slug_idx` unique index.
 * Name and slug are independent (the user types both — option C).
 */
export const createTeamStudioSchema = z.object({
  name: z.string().trim().min(1).max(255),
  slug: studioSlug,
});
export type CreateTeamStudioInput = z.infer<typeof createTeamStudioSchema>;

/**
 * `PATCH /api/v1/studio/:slug` body — edit a studio's display name, URL slug,
 * or bio. Admin-only; every field is optional so the settings form can send
 * only what changed, but an entirely empty patch is refused rather than
 * treated as a successful no-op (it means the client sent nothing to apply).
 *
 * `bio` accepts the empty string, which clears it — distinct from omitting the
 * field, which leaves it untouched. Its 500-character ceiling is an interface
 * contract matching the column, not a tunable.
 */
export const updateStudioSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    slug: studioSlug.optional(),
    bio: z.string().max(500).optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((v) => v !== undefined),
    "empty_patch",
  );
export type UpdateStudioInput = z.infer<typeof updateStudioSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const googleAuthSchema = z.object({
  credential: z.string().min(1),
});
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;

// ── Chat ─────────────────────────────────────────────────────────────

/**
 * Chat-attached chip — a snapshot of a canvas node the user picked
 * from a Space and attached to this message (spec/07-chat-agent.md
 * §10.18.2 v13). The `dataSnapshot` is a deep copy taken at attach
 * time; subsequent Space-side edits / deletions of the source node
 * do NOT mutate the chip (C1 full-snapshot model — same philosophy as
 * spec §6.2 Studio→Space copies).
 */
export const chatAttachedChipSchema = z.object({
  /** Source node id (audit only — not a live reference). */
  id: z.string(),
  type: z.enum(["image", "video", "audio", "text", "annotation"]),
  /** Display name for the chip; LLM context renders this as the section title. */
  name: z.string(),
  /** Deep copy of the source node's `data` at attach time. */
  data_snapshot: z.record(z.string(), z.unknown()),
});
export type ChatAttachedChip = z.infer<typeof chatAttachedChipSchema>;

export const chatMessageSchema = z.object({
  message: z.string().min(1),
  resource_list: z.array(z.string()).default([]),
  project_id: z.string().uuid(),
  /**
   * Which conversation this message belongs to. The client holds it — that is
   * what lets two browser tabs sit on two conversations without either one
   * landing a message in the other. Required: opening chat always hands the
   * client a conversation, so a message without one is a client that skipped
   * that step. The server verifies the conversation is this user's, in this
   * project, and not deleted, before writing anything to it.
   */
  conversation_id: z.string().uuid(),
  /**
   * V13 (spec §10.18.2): canvas-node snapshots the user attached to
   * this message via the chips bar. Required field but defaults to
   * `[]` so legacy callers (skills / SDK that don't surface a chips
   * bar) keep working. The chat handler injects each chip's
   * `data_snapshot` into the LLM prompt as a structured context section.
   */
  attached_chips: z.array(chatAttachedChipSchema).default([]),
  /**
   * V13 (spec §10.18.5): user-picked Skill name (resolved against the
   * registered skills/ directory). Optional — bare chat works without
   * a skill.
   */
  skill: z.string().optional(),
  /**
   * V13: model override. Spec §10.18.5 v13 dropped the in-composer
   * model picker (model is now decided by the Skill or global
   * settings), but we keep the wire field so SDK callers and test
   * cases can override explicitly. Normal chat omits this.
   */
  model: z.string().optional(),
});
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

export const skillCommandSchema = z.object({
  skill_name: z.string().min(1),
  input: z.string().min(1),
  resource_list: z.array(z.string()).default([]),
  /** Same contract as `chatMessageSchema` — both entrances are checked alike. */
  project_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
});
export type SkillCommandInput = z.infer<typeof skillCommandSchema>;

// ── Canvas ───────────────────────────────────────────────────────────

export const taskCreateSchema = z
  .object({
    task_type: z.string(),
    model: z.string().optional(),
    skill_name: z.string().optional(),
    params: z.record(z.string(), z.unknown()),
    /**
     * Result nodes this task will update on completion (1..N).
     * Mini-tools / AIGC tasks always bind to at least one node; other
     * task types (some internal audits) may omit and pass through.
     */
    node_ids: z.array(z.string()).min(1).optional(),
    project_id: z.string().uuid(),
    /**
     * Space within the project the task targets (v10 multi-doc).
     * Worker writes results to `project-{project_id}/canvas-{space_id}`,
     * so this is required. Plain UUID — no FK on the server side.
     */
    space_id: z.string().uuid(),
    source: z.string().default("canvas"),
    /**
     * UUID v4 of the canvas node that will receive the task result.
     * Required when `node_ids` is present (single-node tasks).
     * The worker wraps this into `targetNodeIds: [target_node_id]` in the
     * BullMQ job payload.
     * Omit for tasks that do not bind to a canvas node.
     */
    target_node_id: z.string().uuid().optional(),
    /**
     * Execution mode (spec §10.13 generative dual-button + §10.15 lock).
     * Required — every caller must declare intent explicitly.
     *
     *   - `append`: create a new sibling result node. No lock contention
     *     because the new node has its own UUID. Mini-tools / AIGC direct
     *     flows always use this.
     *   - `overwrite`: replace the existing `target_node_id` node's data.
     *     Requires `target_node_id`. The server SETNX-locks the node so
     *     concurrent overwrites are rejected with `ConflictLocked` 409
     *     (spec §10.15.3 two-tier check).
     */
    mode: z.enum(["append", "overwrite"]),
    /**
     * Lease generation per target node (#1580 #7, unified-gen design
     * 2026-07-03). The frontend — the original trigger, the only party
     * that reads the node's `leaseGen` — computes `gen = leaseGen + 1`
     * per node and sends it here. The server threads each gen into the
     * BullMQ job payload and the handling-open event; the worker echoes
     * it in every write-back; collab CAS-checks it before applying.
     * Required whenever the task binds to a canvas node (enforced by the
     * superRefine below — a record type cannot express "must cover the
     * target id" on its own).
     */
    node_gens: z
      .record(
        z.string().uuid(),
        // Capped at int32 max (#1580 adversarial: an uncapped client gen of
        // MAX_SAFE_INTEGER floods the node's monotonic leaseGen counter and
        // bricks every future backend generation on it). ~2.1e9 generations
        // is one open per second for 68 years — never a legitimate limit.
        z.number().int().positive().lte(2_147_483_647),
      )
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "overwrite" && !val.target_node_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "target_node_id is required when mode is 'overwrite' (spec §10.15.3)",
        path: ["target_node_id"],
      });
    }
    // #1580 #7: a node-bound task must carry a gen for its target node —
    // without it the worker's write-back cannot pass the collab CAS and
    // the result would never land.
    if (val.target_node_id && val.node_gens?.[val.target_node_id] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "node_gens must include target_node_id when the task binds to a node (#1580 #7)",
        path: ["node_gens"],
      });
    }
  });
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const understandSchema = z.object({
  source_type: z.enum(["image", "video", "audio"]),
  source_url: z.string(),
  node_ids: z.array(z.string()).min(1).optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  project_id: z.string().uuid(),
  /** Same as taskCreateSchema.space_id (v10 multi-doc). Required. */
  space_id: z.string().uuid(),
});
export type UnderstandInput = z.infer<typeof understandSchema>;

// ── Projects ─────────────────────────────────────────────────────────

export const projectCreateSchema = z.object({
  /** The studio to create the project in — the create gate checks the caller's role on it (admin/maintainer). */
  studioId: z.string().uuid(),
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(6)
    .max(50)
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "slug must be lowercase letters/digits with single hyphens"),
  visibility: z.enum(["studio", "private"]).default("studio"),
  /**
   * Initial Space type seeded on first open. Canvas is the only editable
   * type today; document/timeline are accepted + plumbed end-to-end
   * (stored on the project, seeded by collab) but disabled in the picker
   * until their editors ship — so picking them later needs zero backend
   * change.
   */
  spaceType: SpaceTypeSchema.default("canvas"),
  description: z.string().optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

// ── Payment ──────────────────────────────────────────────────────────

export const checkoutSchema = z.object({
  tier: z.string().min(1),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ── Pagination ───────────────────────────────────────────────────────

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

/**
 * `GET /chat/conversations` query — pagination plus an optional
 * `project_id` filter. Without the filter, ChatPanel had to pull a
 * page and client-side `find` for a matching project, which dropped
 * silently when the target conversation sat past the page boundary.
 */
export const chatConversationsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  // How many conversations a page holds is a runtime knob that lives in
  // `config/agent.yaml`, and the two routes that list them have to agree on
  // it; a default here would be a second answer to the same question, in a
  // package that cannot read the config. Absent means "whatever the server is
  // configured for".
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Where the last page stopped, rather than how many rows to skip. The list
  // is ordered by when each conversation was last used, so it moves under a
  // reader who is paging through it: someone speaks and a row rises, someone
  // starts one and everything shifts down. Counting rows to skip then lands
  // in the wrong place -- the same conversation comes back twice, or one is
  // stepped over and cannot be reached at all. A position does not move.
  before_updated_at: z.string().datetime({ offset: true }).optional(),
  before_id: z.string().uuid().optional(),
});
export type ChatConversationsQueryInput = z.infer<typeof chatConversationsQuerySchema>;

/**
 * Body for opening chat in a project.
 *
 * Names a project and nothing else: which conversation to show is the server's
 * answer, computed from what the user said last, and it comes back in the
 * response for the client to hold from then on.
 */
export const chatOpenSchema = z.object({
  project_id: z.string().uuid(),
});
export type ChatOpenInput = z.infer<typeof chatOpenSchema>;

/**
 * Body for starting a conversation on purpose.
 *
 * Names the project and nothing else — the same shape as opening chat, and for
 * the same reason: everything about the new conversation is the server's to
 * decide. What separates the two is only whether the caller is willing to be
 * given the one already there.
 */
export const chatCreateConversationSchema = z.object({
  project_id: z.string().uuid(),
});
export type ChatCreateConversationInput = z.infer<typeof chatCreateConversationSchema>;

/**
 * How long a conversation's name may be.
 *
 * One number, because three places enforce it: the two boxes a reader can
 * type a name into and the schema this sits beside. Two numbers means the
 * shorter one silently rewrites names the longer one accepted -- and the
 * reader never asked for that, they only opened a box and closed it again.
 * The column is `varchar(200)`; keep them in step.
 */
export const CONVERSATION_TITLE_MAX_CHARS = 200;

/**
 * Body for naming a conversation.
 *
 * Carries the project as well as the title, because the id in the path came
 * from the client and three things have to hold before anything is written:
 * the conversation exists, it belongs to this user, and it lives in this
 * project. Without the project here the second one cannot be asked at all.
 *
 * The title is trimmed before it is measured, so a name of nothing but spaces
 * is refused rather than stored — a row showing an empty name reads as a
 * rendering fault, which is worse than the default title it replaced.
 */
export const chatRenameConversationSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_CHARS),
});
export type ChatRenameConversationInput = z.infer<typeof chatRenameConversationSchema>;

/**
 * Query for the page of a conversation that comes before the one in hand.
 *
 * The cursor is a turn and not a message, because a page ends on a turn
 * boundary: asking for everything before a message would let a turn's answer
 * be read without its question.
 */
export const chatEarlierMessagesQuerySchema = z.object({
  before_turn: z.coerce.number().int().positive(),
});
export type ChatEarlierMessagesQueryInput = z.infer<typeof chatEarlierMessagesQuerySchema>;
