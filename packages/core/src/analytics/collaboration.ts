// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The collaboration milestone (inner#1442 design §4.8, §4.9): someone other
 * than a project's creator does something in it for the first time. Reported
 * from server, worker and collab, so it lives here.
 */

import {
  adClickFrom,
  CONSENT_REVISION,
  type AccountConsent,
  type ConsentSnapshot,
  type ProjectActivityType,
} from "@breatic/shared";
import { adsConversionConfig, enqueueAdsConversion } from "@core/ads/ads-conversion.js";
import { getAccountAttribution, getAccountConsent } from "@core/analytics/account.repo.js";
import { currentConsent } from "@core/analytics/consent-context.js";
import { claimMilestone } from "@core/analytics/milestone.repo.js";
import { reportAnalyticsFailure, serverAnalyticsOn, trackServerEvent } from "@core/analytics/server-analytics.js";
import { getOwner } from "@core/auth/projectMembers.repo.js";
import { findCreatorAndStudio } from "@core/project/projects.repo.js";

/** What kind of first action it was. */
export type CollaborationAction = "space" | "asset" | "generation" | "agent";

/**
 * The milestone action an activity row stands for.
 * @param type - The activity type written.
 * @returns The action, or null for a type the milestone does not count (`member:*`, `asset:deleted`).
 */
export function collaborationActionOf(type: ProjectActivityType): CollaborationAction | null {
  if (type.startsWith("space:")) return "space";
  if (type === "asset:uploaded") return "asset";
  if (type.startsWith("generation:")) return "generation";
  return null;
}

/**
 * The account's latest consent, when it was made under the current policy.
 * @param userId - The account.
 * @returns The choice, or null; callers treat null as no consent.
 */
export async function accountConsentInForce(userId: string): Promise<AccountConsent | null> {
  const stored = await getAccountConsent(userId);
  return stored?.revision === CONSENT_REVISION ? stored : null;
}

/**
 * Report a collaborator's first action in a project, once per person and
 * project; the project's first one also counts as the owner's collaboration
 * conversion, under the owner's latest consent. Never rejects: a failure goes
 * to the entry's error callback, and the action it rides on carries on.
 * @param input - The action.
 * @param input.projectId - Where it happened.
 * @param input.userId - Who did it.
 * @param input.action - What kind it was.
 * @param consent - The choice of the browser behind it; defaults to the current context's.
 * @returns Once reported, or once it turned out there was nothing to report.
 */
export async function reportCollaboratorFirstAction(
  input: { projectId: string; userId: string; action: CollaborationAction },
  consent: ConsentSnapshot = currentConsent(),
): Promise<void> {
  if (!serverAnalyticsOn() && adsConversionConfig() === null) return;
  try {
    const project = await findCreatorAndStudio(input.projectId);
    if (!project || project.createdByUserId === input.userId) return;
    const key = `collab:${input.projectId}:${input.userId}`;
    if (!(await claimMilestone(key))) return;
    trackServerEvent(
      "collaborator_first_action",
      {
        userId: input.userId,
        insertId: key,
        properties: { studio_id: project.studioId, project_id: input.projectId, action: input.action },
      },
      consent,
    );
    const ownerId = await getOwner(input.projectId);
    const ownerConsent = ownerId ? await accountConsentInForce(ownerId) : null;
    if (!ownerId || !ownerConsent) return;
    await enqueueAdsConversion(
      {
        conversion: "collaboration",
        transactionId: `collab:${ownerId}`,
        click: adClickFrom(await getAccountAttribution(ownerId), Date.now()),
      },
      ownerConsent,
    );
  } catch (err) {
    reportAnalyticsFailure(`collaborator_first_action: ${err instanceof Error ? err.message : String(err)}`);
  }
}
