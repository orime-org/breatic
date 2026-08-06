// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Telling an operator that a document's content had to be rescued to disk
 * instead of stored (#40).
 *
 * Without this the rescue file is a file nobody knows exists. Two things
 * would otherwise defeat it quietly:
 *
 *   the mail backend  `EMAIL_BACKEND` defaults to `disabled` and BOTH
 *                     deployment templates ship it disabled, so an
 *                     undelivered alert is the default outcome, not an edge
 *                     case. It is logged rather than swallowed.
 *   the volume        one database outage means one failure per open
 *                     document per round. Alerts are collapsed to one per
 *                     document per window.
 */

import { createLogger } from "@breatic/core";
import type { SendMailOptions, SendMailResult } from "@breatic/core";

const logger = createLogger("collab-store-alert");

/** What an operator has to be told about one rescued document. */
export interface StoreFailureAlert {
  /** Full Yjs document name. */
  documentName: string;
  /** Where the content was written on this host. */
  rescuePath: string;
  /** How much content is in that file. */
  bytes: number;
  /** Why the database refused it. */
  reason: string;
}

/** Collaborators the alerter needs. */
export interface StoreAlerterDeps {
  /** Operations mailbox; empty means alerts cannot be delivered. */
  to: string;
  /** How long one document stays quiet after an alert. */
  windowMs: number;
  /** Which collab instance this is — the rescue file only exists here. */
  instanceId: string;
  /** Mail transport. */
  send(options: SendMailOptions): Promise<SendMailResult>;
  /** Clock, overridable in tests. */
  now?: () => number;
}

/** An alerter that collapses repeats. */
export interface StoreAlerter {
  /** Tell operations about one rescued document, subject to the window. */
  alert(failure: StoreFailureAlert): Promise<void>;
}

/**
 * Render the alert body.
 * @param failure - The rescued document.
 * @param instanceId - Host the rescue file lives on.
 * @returns HTML body naming everything needed to find and read the file.
 */
function renderBody(failure: StoreFailureAlert, instanceId: string): string {
  return [
    `<p>A collab document could not be stored. Its content was written to disk instead.</p>`,
    `<ul>`,
    `<li>instance: <code>${instanceId}</code></li>`,
    `<li>document: <code>${failure.documentName}</code></li>`,
    `<li>rescue file: <code>${failure.rescuePath}</code></li>`,
    `<li>size: ${failure.bytes} bytes</li>`,
    `<li>reason: <code>${failure.reason}</code></li>`,
    `</ul>`,
    `<p>The file is on that host only and is never removed automatically.</p>`,
  ].join("");
}

/**
 * Build the alerter.
 * @param deps - Recipient, window, instance, transport, and clock.
 * @returns An alerter that sends at most one mail per document per window.
 */
export function createStoreAlerter(deps: StoreAlerterDeps): StoreAlerter {
  const now = deps.now ?? ((): number => Date.now());
  /** When each document last opened its quiet window. */
  const lastAlertAt = new Map<string, number>();

  return {
    alert: async (failure: StoreFailureAlert): Promise<void> => {
      const previous = lastAlertAt.get(failure.documentName);
      if (previous !== undefined && now() - previous < deps.windowMs) return;
      // Opened before the attempt, not after: a transport that throws every
      // time would otherwise leave the window shut and flood on every round.
      lastAlertAt.set(failure.documentName, now());

      if (!deps.to) {
        logger.warn(
          { ...failure, instanceId: deps.instanceId, cause: "no recipient configured" },
          "collab_store_alert_undeliverable",
        );
        return;
      }

      try {
        const result = await deps.send({
          to: deps.to,
          subject: `[breatic] collab could not store ${failure.documentName}`,
          html: renderBody(failure, deps.instanceId),
        });
        if (result.status !== "sent") {
          logger.warn(
            { ...failure, instanceId: deps.instanceId, cause: result.status },
            "collab_store_alert_undeliverable",
          );
        }
      } catch (err) {
        logger.error(
          { err, ...failure, instanceId: deps.instanceId },
          "collab_store_alert_failed",
        );
      }
    },
  };
}
