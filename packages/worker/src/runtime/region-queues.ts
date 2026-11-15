// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which BullMQ queues a worker runs in its region (inner#1955).
 *
 * Work on global data (ads conversions, settling slug reservations,
 * forwarding revocations and email-invitation claims to other regions) runs
 * only in the global region; relaying the outbox and retrying hold releases
 * run only where there is a global region to call; reporting storage use runs
 * only where another region exists to read it. Everything else that works on
 * a region's own Studios runs in every region.
 */

import { ADS_CONVERSION_QUEUE, IDENTITY_REVOCATION_FORWARD_QUEUE, INVITATION_CLAIM_FORWARD_QUEUE, TIMELINE_QUEUE } from "@breatic/core";
import {
  AUDIO_PEAKS_QUEUE,
  creditHoldService,
  MAIL_QUEUE,
  MEDIA_READ_QUEUE,
  UPLOAD_FINISH_QUEUE,
  USAGE_LOOKUP_QUEUE,
} from "@breatic/domain";
import { LONG_MEDIA_DISPATCH_QUEUE } from "@worker/handlers/long-media-dispatch.js";

/** The recurring sweep of Timeline executions that have not ended (inner#1711). */
export const TIMELINE_SWEEP_QUEUE = "timeline-sweep";
/** The recurring sweep of charge requests still pending (inner#1617). */
export const CREDIT_CHARGE_SWEEP_QUEUE = "credit-charge-sweep";
/** The sweep that settles slug reservations a region's rename left behind. */
export const SLUG_RESERVATION_SWEEP_QUEUE = "slug-reservation-sweep";
export { IDENTITY_REVOCATION_FORWARD_QUEUE, INVITATION_CLAIM_FORWARD_QUEUE } from "@breatic/core";
/** The relay of this region's outbox to the global region. */
export const REGION_OUTBOX_RELAY_QUEUE = "region-outbox-relay";
/** This region's storage report to the global region. */
export const STORAGE_USAGE_SYNC_QUEUE = "storage-usage-sync";

const EVERY_REGION: readonly string[] = [
  "tasks",
  "url-ingest",
  UPLOAD_FINISH_QUEUE,
  USAGE_LOOKUP_QUEUE,
  MEDIA_READ_QUEUE,
  AUDIO_PEAKS_QUEUE,
  MAIL_QUEUE,
  LONG_MEDIA_DISPATCH_QUEUE,
  TIMELINE_QUEUE,
  TIMELINE_SWEEP_QUEUE,
  CREDIT_CHARGE_SWEEP_QUEUE,
];

/** Work on global data, run by the global region of any deployment. */
const GLOBAL_ONLY: readonly string[] = [ADS_CONVERSION_QUEUE];

/** What the global region does for the other regions, run only when there are any. */
const GLOBAL_WITH_REGIONS: readonly string[] = [
  SLUG_RESERVATION_SWEEP_QUEUE,
  IDENTITY_REVOCATION_FORWARD_QUEUE,
  INVITATION_CLAIM_FORWARD_QUEUE,
  STORAGE_USAGE_SYNC_QUEUE,
];

/** Hold releases the global region could not take when they were made. */
export const CREDIT_HOLD_RELEASE_QUEUE = creditHoldService.CREDIT_HOLD_RELEASE_QUEUE;

/** What every other region does for the global region. */
const REGIONAL_ONLY: readonly string[] = [REGION_OUTBOX_RELAY_QUEUE, STORAGE_USAGE_SYNC_QUEUE, CREDIT_HOLD_RELEASE_QUEUE];

/**
 * The queues a worker in this region runs.
 * @param where - This region, the global region and the other regions.
 * @param where.region - The region the worker runs in.
 * @param where.globalRegion - The region that holds the global data.
 * @param where.otherRegions - The regions this deployment reaches besides its own.
 * @returns The queue names.
 */
export function workerQueuesFor(where: { region: string; globalRegion: string; otherRegions: readonly string[] }): string[] {
  if (where.region !== where.globalRegion) return [...EVERY_REGION, ...REGIONAL_ONLY];
  return [...EVERY_REGION, ...GLOBAL_ONLY, ...(where.otherRegions.length > 0 ? GLOBAL_WITH_REGIONS : [])];
}
