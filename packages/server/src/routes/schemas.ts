// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * API request schemas — re-exported from `@breatic/shared`.
 *
 * Server-only schemas (mini-tool discriminated unions) remain defined
 * here. Shared schemas are the single source of truth.
 */

// ── Re-export shared schemas ────────────────────────────────────────
export {
  registerSchema,
  signupVerifySchema,
  setupStudioSchema,
  loginSchema,
  chatMessageSchema,
  taskCreateSchema,
  understandSchema,
  nodeHistorySnapshotSchema,
  projectCreateSchema,
  checkoutSchema,
  paymentConfirmSchema,
  paymentCancelSchema,
  paymentHistoryQuerySchema,
  paginationSchema,
  chatConversationsQuerySchema,
  chatOpenSchema,
  chatEarlierMessagesQuerySchema,
  chatCreateConversationSchema,
  chatRenameConversationSchema,
} from "@breatic/shared";

// ── Server-only schemas (complex discriminated unions) ───────────────

import { z } from "zod";
import { ARCHIVED_PROJECT_SORTS, LIVE_PROJECT_SORTS } from "@breatic/shared";
import { creditLotService } from "@breatic/domain";

// Mini-Tools: Text
const textToolBase = z.object({
  document: z.string().optional(),
  selection: z.string().optional(),
  instructions: z.string().optional(),
  node_ids: z.array(z.string()).min(1).optional(),
  project_id: z.string().optional(),
});

export const textToolSchema = z.discriminatedUnion("tool", [
  textToolBase.extend({ tool: z.literal("polish"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("expand"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("summarize"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("translate"), document: z.string(), selection: z.string(), language: z.string() }),
  textToolBase.extend({ tool: z.literal("rewrite"), document: z.string(), selection: z.string(), style: z.string().optional() }),
  textToolBase.extend({ tool: z.literal("continue"), document: z.string(), selection: z.string() }),
  textToolBase.extend({ tool: z.literal("generate"), instructions: z.string() }),
  textToolBase.extend({ tool: z.literal("character"), name: z.string(), traits: z.string().optional(), context: z.string().optional() }),
  textToolBase.extend({ tool: z.literal("storyboard"), instructions: z.string(), scene_count: z.number().int().optional() }),
  textToolBase.extend({ tool: z.literal("script"), scene_description: z.string(), characters: z.array(z.string()).optional() }),
]);

/**
 * The `Idempotency-Key` header, as the charge will read it.
 *
 * The header travels into the charge as its reference key, where
 * `REFKEY_PATTERN` refuses anything outside it. Refusing there is refusing
 * too late: the model has already run and the tokens are already spent, so
 * the caller pays for a run whose charge cannot be recorded. The same pattern
 * is asked here, at the door, and the answer is a `422` before any of that.
 *
 * Absent is fine — the route then mints a key of its own and each retry is
 * its own charge, which is what a text tool means when it regenerates.
 * Hono lowercases header names, so the key below is the name as it arrives.
 */
export const idempotencyKeyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .regex(creditLotService.REFKEY_PATTERN)
    .optional(),
});

/**
 * Both ids in the attachment path.
 *
 * `aid` for the reason `idParamSchema` gives -- it goes to a query. `cid` is
 * not read by the handler at all, and is declared here so that the path
 * means what it says:
 * an attachment named under a conversation that is not one is not a request
 * this route should be answering.
 */
export const attachmentParamSchema = z.object({
  cid: z.string().uuid(),
  aid: z.string().uuid(),
});

/**
 * Keyset paging for the credit overlay. Both fields are optional: the first
 * page asks for neither, and the page size falls back to the configured
 * default when the client omits it. Kept as strings because the service
 * clamps `limit` against `config/limits.yaml` and treats a malformed cursor
 * as "first page" — a garbage value from the network must not fail the panel.
 */
export const creditPageQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

/**
 * `GET /studio/:slug/projects`: which list, how it is sorted, and the page.
 *
 * A sort the list does not offer is refused, so the live list cannot be asked
 * for the archive order and the other way round. `limit` is clamped by the
 * service against `config/limits.yaml`; a malformed cursor reads as the first
 * page there.
 */
export const projectListQuerySchema = z
  .object({
    archived: z.enum(["true", "false"]).optional(),
    sort: z.enum([...LIVE_PROJECT_SORTS, ...ARCHIVED_PROJECT_SORTS]).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .refine(
    (q) =>
      q.sort === undefined ||
      (q.archived === "true"
        ? (ARCHIVED_PROJECT_SORTS as readonly string[]).includes(q.sort)
        : (LIVE_PROJECT_SORTS as readonly string[]).includes(q.sort)),
    { path: ["sort"] },
  );

/**
 * Purchases, optionally narrowed to one lifecycle. Three sections read the
 * same list and each wants its own subset, and narrowing after the page is
 * cut would leave a page with nothing on it while the cursor says there is
 * more.
 */
export const creditLotQuerySchema = creditPageQuerySchema.extend({
  lifecycle: z
    .enum(["active", "depleted", "refund_pending", "refunding", "refunded"])
    .optional(),
});

/** The ledger takes the same paging, plus an optional studio filter. */
export const creditLedgerQuerySchema = creditPageQuerySchema.extend({
  studioId: z.string().uuid().optional(),
});

/**
 * Which studio may spend a purchase. `null` means unassigned, so the field is
 * required rather than optional: omitting it is a malformed request, while
 * sending null is an instruction to take the purchase back.
 */
export const designationSchema = z.object({
  studioId: z.string().uuid().nullable(),
});

/**
 * A uuid named in a path.
 *
 * Without it the id goes straight to a query, where PG rejects a malformed
 * uuid by throwing -- and nothing recognises that throw, so an input that
 * should read as "no such thing" comes back as a 500 with an error-level log
 * behind it, which anyone can produce as fast as they can send requests.
 */
export const idParamSchema = z.object({ id: z.string().uuid() });
