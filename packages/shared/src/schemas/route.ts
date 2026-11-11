// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";

/**
 * How a run chooses the upstream that serves it (inner#1743): by the deployment's weights, only through one named
 * upstream, or the cheapest one able to take the run. provider's `Route`, which this schema is checked against where
 * the value is passed.
 */
export const routeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("default") }),
  z.strictObject({ mode: z.literal("upstream"), upstream: z.string().min(1).max(64) }),
  z.strictObject({ mode: z.literal("cheapest") }),
]);

/** How a run chooses the upstream that serves it. */
export type RunRoute = z.infer<typeof routeSchema>;
