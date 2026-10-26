// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

/** Existing tasks-queue names distinguish pure delivery from computation. */
export const MINI_TOOL_DELIVERY_JOB = "deliver-mini-tool-results";
export const MINI_TOOL_DELIVERY_DISCOVERY_JOB = "discover-mini-tool-deliveries";

/** A queue wake carries only its original SQL identity and delivery version. */
export interface MiniToolDeliveryWake { taskId: string; deliveryVersion: number }
/** Discovery continues by the exact SQL task primary key. */
export interface MiniToolDeliveryDiscovery { cursor?: { taskId: string } }

/** RED placeholder: the adopted wake parser has no accepting implementation yet. */
export const miniToolDeliveryWakeSchema: z.ZodType<MiniToolDeliveryWake> = z.never();
/** RED placeholder: the adopted discovery parser has no accepting implementation yet. */
export const miniToolDeliveryDiscoverySchema: z.ZodType<MiniToolDeliveryDiscovery> = z.never();
