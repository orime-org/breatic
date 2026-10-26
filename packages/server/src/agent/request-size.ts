// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How big a turn's request is, in tokens, and what each turn of its history
 * added: the figures the fold check and a reply row's sizes are read from.
 */

import { measureInstructionsAndTools, measureMessages } from "@server/agent/payload-size.js";
import type { TurnCost } from "@server/agent/consolidation-window.js";
import type { ReplayedRow } from "@server/agent/history-replay.js";
import type { Assembly } from "@server/agent/turn-fold.js";

/**
 * What each turn in the history added to the conversation, oldest first.
 *
 * A stored provider count is reused only when its coverage remains valid
 * (legacy rows have no coverage hashes). Otherwise the replayed messages are
 * estimated from text characters and configured picture token costs.
 * @param replayed - The history, row by row, as it is replayed.
 * @returns Each turn and what taking it saves.
 * @throws {never} Never.
 */
export function costPerTurn(replayed: readonly ReplayedRow[]): TurnCost[] {
  const byTurn = new Map<number, ReplayedRow[]>();
  for (const one of replayed) {
    const found = byTurn.get(one.row.turnIndex);
    if (found) found.push(one);
    else byTurn.set(one.row.turnIndex, [one]);
  }

  // In turn order: the history is read oldest first. A turn paused at a
  // questionnaire has a reply for each segment, and each reply's count is what
  // its own segment added, so the turn weighs all of them; the reader's
  // message is inside the first one's count.
  return [...byTurn.entries()].map(([turnIndex, rows]) => {
    if (!rows.some((one) => one.reply !== undefined)) {
      return { turnIndex, tokens: measureMessages(rows.flatMap((one) => one.messages)) };
    }
    const hasCoverage = rows.some((one) => one.reply?.countCoverage !== undefined);
    const invalid = rows.some((one) => {
      if (hasCoverage && one.row.role === "assistant" && (one.reply === undefined || !one.asSent)) return true;
      const coverage = one.reply?.countCoverage;
      return coverage !== undefined && (!one.asSent || coverage.turnHash === undefined || coverage.turnHash !== one.turnCoverageHash);
    });
    if (invalid) return { turnIndex, tokens: measureMessages(rows.flatMap((one) => one.messages)) };
    const tokens = rows.reduce(
      (sum, one) =>
        sum + (one.reply?.turnTokens ?? (one.row.role === "assistant" ? measureMessages(one.messages) : 0)),
      0,
    );
    return { turnIndex, tokens };
  });
}

/**
 * How big the request is, in tokens.
 *
 * The newest unchanged reply with valid count coverage says how big the
 * conversation was when its turn ended; legacy rows have no coverage hashes.
 * What came after it is
 * added on. Without one -- the conversation was folded since, the system
 * prompt, tools or model changed, or nothing was kept -- it is the system prompt and tools, what each turn added, and this
 * turn's question.
 * @param assembly - What this turn would send.
 * @param turns - What each turn of its history added.
 * @returns The size, using text characters and picture costs outside valid counts.
 * @throws {never} Never.
 */
export function requestTokens(
  assembly: Assembly,
  turns: readonly TurnCost[] = costPerTurn(assembly.replayed),
): number {
  const { replayed } = assembly;
  const question = measureMessages(assembly.messages.slice(-1));
  const newestAsSent = replayed.findLastIndex((one) => {
    if (!one.asSent || one.reply === undefined) return false;
    const coverage = one.reply.countCoverage;
    return coverage === undefined || (coverage.endHash !== undefined && coverage.endHash === one.endCoverageHash);
  });
  const sized = replayed[newestAsSent]?.reply;
  if (sized !== undefined) {
    const after = replayed.slice(newestAsSent + 1).flatMap((one) => one.messages);
    return sized.endTokens + measureMessages(after) + question;
  }
  return measureInstructionsAndTools(assembly.agentConfig) + turns.reduce((sum, turn) => sum + turn.tokens, 0) + question;
}

/**
 * The provider's count a turn starts from: the newest reply's `endTokens`,
 * only when the provider reported it and that reply's last request is still
 * the prefix this turn replays (inner#1567, design 6.2). Anything else --
 * a character fallback, a row from before the count had a source, a system
 * prompt, memory or model that changed since -- leaves nothing to check.
 * @param replayed - The history, row by row, as it is replayed.
 * @returns The count, or undefined when there is none to trust.
 * @throws {never} Never.
 */
export function knownTokensAtStart(replayed: readonly ReplayedRow[]): number | undefined {
  const newest = replayed.findLast((one) => one.row.role === "assistant");
  if (newest?.reply?.endTokensFrom !== "provider" || newest.lastRequestMatches !== true) return undefined;
  return newest.reply.endTokens;
}
