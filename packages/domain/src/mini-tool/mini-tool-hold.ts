// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DbTx } from "@breatic/core";

/**
 * Holds a mini-tool run's estimate under its task id inside the transaction that claims that id, or throws the refusal
 * (the balance or a monthly spend limit), which rolls the claim back (inner#1968 design 3.10 U9): a refused run leaves
 * no task row, no pin and no node row, and a second request for the same run waits on the claim and replays it. The
 * application passes its admission (`reserveForRunIn` in server), which owns the refusal.
 */
export type MiniToolHold = (taskId: string, credits: number, tx: DbTx) => Promise<void>;
