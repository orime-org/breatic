// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** Existing tasks-queue names distinguish pure delivery from computation. */
export const MINI_TOOL_DELIVERY_JOB = "deliver-mini-tool-results";
export const MINI_TOOL_DELIVERY_DISCOVERY_JOB = "discover-mini-tool-deliveries";

/** A queue wake carries only its original SQL identity and delivery version. */
export interface MiniToolDeliveryWake { taskId: string; deliveryVersion: number }
/** Discovery continues by the exact SQL task primary key. */
export interface MiniToolDeliveryDiscovery { cursor?: { taskId: string } }

/** The original delivery identity is validated before any SQL recovery. */
export const miniToolDeliveryWakeSchema: z.ZodType<MiniToolDeliveryWake> = z.strictObject({ taskId: z.uuid(), deliveryVersion: z.number().int().positive() });
/** Discovery carries the exact primary-key continuation of its SQL page. */
export const miniToolDeliveryDiscoverySchema: z.ZodType<MiniToolDeliveryDiscovery> = z.strictObject({ cursor: z.strictObject({ taskId: z.uuid() }).optional() });
