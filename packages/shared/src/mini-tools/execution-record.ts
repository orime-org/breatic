// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import type { MiniToolSourceBinding } from "@shared/mini-tools/analysis-record.js";
import type { MiniToolPlannedRequest } from "@shared/mini-tools/planned-request-schema.js";

/** Public registered cover facts, independent from provider presentation derivatives. */
export interface MiniToolExecutionCover {
  assetId: string; canonicalURL: string; kind: "image"; mimeType: string; size: number;
  contentHash: string; width: number | null; height: number | null;
}
/** Public canonical media identity and measured, nullable metadata. */
export interface MiniToolExecutionRegistered {
  status: "registered"; assetId: string; canonicalURL: string;
  kind: "image" | "video" | "audio" | "document" | "file";
  mimeType: string; size: number; contentHash: string;
  width: number | null; height: number | null; duration: number | null;
  cover: MiniToolExecutionCover | null;
}
/** One stable planned slot, including a terminal failure or an admissible late result. */
export interface MiniToolExecutionOutput {
  outputIndex: number; nodeId: string; recipe: MiniToolPlannedRequest["outputs"][number]["recipe"];
  result: MiniToolExecutionRegistered | { status: "failed"; error: Record<string, z.infer<ReturnType<typeof z.json>>> } | null;
  late: boolean;
}
/** A deliberately narrow public copy of the existing step-owned consumption fact. */
export interface MiniToolExecutionUsage {
  consumptionKey: string; state: "pending" | "known" | "recorded"; chargeTo: "user" | "platform";
  costUsd: number | null; credits: number | null;
}
/** Project-readable execution state; no storage capability or provider response is public. */
export interface MiniToolExecutionRecord {
  schemaVersion: 1; runId: string; status: "pending" | "running" | "completed" | "failed" | "cancelled";
  planFingerprint: string; resultVersion: number; sourceBindings: MiniToolSourceBinding[];
  outputs: MiniToolExecutionOutput[]; usage: MiniToolExecutionUsage[];
  billingState: "idle" | "waiting" | "checking" | "settled";
  error: Record<string, z.infer<ReturnType<typeof z.json>>> | null;
}

/** Loadable RED schema; the independent execution-record contract is not implemented yet. */
export const miniToolExecutionRecordSchema = z.custom<MiniToolExecutionRecord>(() => false, "Execution record schema is not implemented");
