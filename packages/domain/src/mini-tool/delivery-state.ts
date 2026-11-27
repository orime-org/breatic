// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import type { DbTx } from "@breatic/core";
import type { TaskEntity } from "@breatic/shared";
import type { MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import type { MiniToolDeliveryState } from "@domain/mini-tool/delivery.service.js";
import * as taskRepo from "@domain/task/task.repo.js";

const deliverySchema = z.strictObject({
  schemaVersion: z.literal(1), planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  outputs: z.array(z.strictObject({ outputIndex: z.number().int().nonnegative(), state: z.enum(["pending", "published", "history_only"]) })).min(1),
  lastErrorCode: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable(),
});

/**
 * Establish pending slots in the manifest transaction while retaining completed deliveries.
 * @param task - The original parent read under its immutable task lock.
 * @param record - Its validated current or newly committed public manifest.
 * @param tx - The transaction retaining that lock and every sibling write.
 * @returns The independent delivery state, or null before a registered manifest exists.
 * @throws {Error} When persisted delivery identity differs from its canonical manifest or storage fails.
 */
export async function synchronizeMiniToolDelivery(task: TaskEntity, record: MiniToolExecutionRecord, tx: DbTx): Promise<MiniToolDeliveryState | null> {
  const registered = record.outputs.filter((output) => output.result?.status === "registered");
  const stored = task.result?.miniToolDelivery;
  const current = stored === undefined ? null : deliverySchema.parse(stored);
  if (current !== null && (current.planFingerprint !== record.planFingerprint
    || new Set(current.outputs.map((output) => output.outputIndex)).size !== current.outputs.length
    || current.outputs.some((output) => !registered.some((slot) => slot.outputIndex === output.outputIndex)))) {
    throw new Error("Delivery differs from its original registered manifest");
  }
  if (registered.length === 0) return null;
  const added = registered.filter((slot) => !current?.outputs.some((output) => output.outputIndex === slot.outputIndex));
  if (added.length === 0) return current;
  const delivery: MiniToolDeliveryState = {
    schemaVersion: 1, planFingerprint: record.planFingerprint, version: (current?.version ?? 0) + 1,
    outputs: [...(current?.outputs ?? []), ...added.map((slot) => ({ outputIndex: slot.outputIndex, state: "pending" as const }))]
      .sort((left, right) => left.outputIndex - right.outputIndex),
    lastErrorCode: null,
  };
  await taskRepo.storeMiniToolDelivery(task.id, delivery, tx);
  return delivery;
}
