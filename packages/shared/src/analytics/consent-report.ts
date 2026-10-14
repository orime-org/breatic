// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a signed-in browser sends to `PUT /me/analytics-consent` (inner#1442
 * design §4.4.6): the latest choice for each category, one receipt each.
 */

import { z } from "zod";

/** One category's latest choice, as the cookie holds it. */
export const ConsentDecisionSchema = z
  .object({
    decisionId: z.string().uuid(),
    category: z.enum(["analytics", "ads"]),
    value: z.boolean(),
    // A regional default is no choice of the person's, and only operators record requests.
    source: z.enum(["banner", "settings", "gpc"]),
    noticeShown: z.union([z.literal("gpc"), z.literal("account"), z.literal(false)]),
    gpcAtDecision: z.boolean(),
    decidedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((d) => d.source !== "gpc" || (d.category === "ads" && !d.value), {
    message: "a GPC decision is only ever an ads refusal",
  })
  .refine((d) => d.noticeShown === false || (d.category === "ads" && d.source === "settings"), {
    message: "an opt-out notice belongs only to an ads choice made in settings",
  });

/** The report body. */
export const ConsentReportSchema = z
  .object({
    decisions: z.array(ConsentDecisionSchema).min(1).max(2),
    // The column is a Postgres integer; revisions start at 1.
    revision: z.number().int().min(1).max(2_147_483_647),
    /** The browser's clock when it sent the report, so the server can correct a skewed clock. */
    sentAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((r) => new Set(r.decisions.map((d) => d.decisionId)).size === r.decisions.length, {
    message: "a decision id appears once per report",
  });

/** One category's latest choice. */
export type ConsentDecision = z.infer<typeof ConsentDecisionSchema>;
/** The report body. */
export type ConsentReport = z.infer<typeof ConsentReportSchema>;

/** The report body's field names, compared by the website's contract test. */
export const CONSENT_REPORT_FIELDS = ["decisions", "revision", "sentAt"] as const;
