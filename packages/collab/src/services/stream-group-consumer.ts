// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  createLogger,
  startGroupConsumer as startCoreGroupConsumer,
  type GroupConsumer,
  type GroupConsumerOptions as CoreGroupConsumerOptions,
  type GroupConsumerReport,
} from "@breatic/core";

export { retryDelayMs } from "@breatic/core";
export type { EntryOutcome, GroupConsumer, GroupConsumerSettings, StreamEntry } from "@breatic/core";

/** The compatible collab consumer contract; application reporting stays here. */
export type GroupConsumerOptions = Omit<CoreGroupConsumerOptions, "report" | "connectionNamePrefix">;

const logger = createLogger("stream-group-consumer");

/**
 * Record a consumer event at its existing application log level.
 * @param report - The lifecycle or delivery event from the common consumer.
 */
function reportConsumerEvent(report: GroupConsumerReport): void {
  switch (report.event) {
    case "stream_group_created":
    case "stream_group_consumer_forgotten":
    case "stream_entries_handed_over":
      logger.info(report.context, report.event);
      return;
    case "stream_entries_trimmed_before_handled":
    case "stream_entry_failed_will_retry":
    case "stream_entries_renew_failed":
      logger.warn(report.context, report.event);
      return;
    default:
      logger.error(report.context, report.event);
  }
}

/**
 * Start the shared consumer with collab's existing diagnostics.
 * @param opts - Stream, group, names, limits, the key function and round handler.
 * @returns The running consumer.
 */
export function startGroupConsumer(opts: GroupConsumerOptions): GroupConsumer {
  return startCoreGroupConsumer({
    ...opts,
    connectionNamePrefix: "collab-group",
    report: reportConsumerEvent,
  });
}
