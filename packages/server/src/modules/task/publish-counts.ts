// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling the other viewers of a canvas that a node's counts moved (#186,
 * design §4.6.4).
 *
 * The request that moved them already holds its own answer: the rows it read,
 * the ticket it signed, the record it cleared. This broadcast is for everyone
 * else with that canvas open, and reaching them is not what the request was
 * for.
 *
 * So an unreachable stream does not fail the request. The stream lives on its
 * own Redis connection, one of several that are being split into independent
 * instances, and losing one of them for a few seconds is an ordinary network
 * incident: the next event gets through, and anyone who missed this one sees
 * the current numbers the moment they open the node's list, which is what
 * harvests and republishes them. Failing the request instead would take an
 * answer that succeeded and throw it away — and on the paths that already
 * wrote to the database, it would leave the user looking at a record the
 * table no longer holds.
 *
 * It is logged, because an outage nobody can see afterwards is one nobody
 * fixes.
 */

import { getStreamRedis, logger } from "@breatic/core";
import { emitNodeTaskCounts } from "@breatic/domain";
import type { NodeTaskCounts } from "@breatic/shared";

/**
 * Publish a node's four counts, and carry on if that fails.
 *
 * Only for events carrying nothing but the numbers. An event carrying a
 * task's content is the one way that content reaches the node, so it goes
 * through `emitNodeTaskCounts` directly and its failure belongs to the
 * caller — which is why that function's content parameter is required rather
 * than optional.
 * @param docName - Canvas doc the node lives in.
 * @param nodeId - The node these counts belong to.
 * @param counts - All four, freshly counted from `node_tasks`.
 */
export async function publishCountsQuietly(
  docName: string,
  nodeId: string,
  counts: NodeTaskCounts,
): Promise<void> {
  try {
    await emitNodeTaskCounts(getStreamRedis(), docName, nodeId, counts, undefined);
  } catch (err) {
    logger.error(
      { err, docName, nodeId, counts },
      "node_task_counts_publish_failed",
    );
  }
}
