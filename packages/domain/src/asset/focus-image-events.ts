// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telling collab where a focus crop's upload stands (#1580).
 *
 * A crop in a node's reference list is uploading the way a row in its task list is running: the backend publishes and
 * collab writes the node, the way a node's task counts reach it (`node-task-counts`) and a Document block receives
 * its upload (`document-upload-events`). The upload shows as uploading once its grant opens, until its deadline; its
 * ending moves it into the pool or takes it away. Failing to publish an ending throws: an upload finish job runs again,
 * and a ticket answered by a dedup hit fails and the page shows the failure.
 */

import { budgetDeadlineFrom, getStreamRedis, publishFocusImageUploadEvent } from "@breatic/core";
import { canvasSpaceDocName, FOCUS_IMAGE_UPLOAD_EVENT_TYPE, type FocusImageUploadEvent, type StudioAssetEntity } from "@breatic/shared";
import { findGrantByKey, type GrantFocusImage, type UploadGrant } from "@domain/asset/upload-grant.repo.js";

/** Where a crop goes and what it becomes. */
export interface FocusImageTarget {
  projectId: string;
  focusImage: GrantFocusImage;
}

/**
 * The pool a grant's bytes land in, when it is a focus crop's.
 * @param grant - The upload's grant.
 * @returns The target, or null.
 */
export function focusImageTargetOf(grant: Pick<UploadGrant, "projectId" | "focusImage">): FocusImageTarget | null {
  if (grant.projectId === null || grant.focusImage === null) return null;
  return { projectId: grant.projectId, focusImage: grant.focusImage };
}

/** One step of an upload, without the fields every step carries; distributed over the union so each step keeps its shape. */
type Step = FocusImageUploadEvent extends infer E ? (E extends unknown ? Omit<E, "type" | "docName" | "nodeId"> : never) : never;

/**
 * Publish one step for a target.
 * @param target - The pool and the image.
 * @param step - The step.
 * @returns Nothing.
 * @throws {Error} When the stream rejects the entry.
 */
async function publish(target: FocusImageTarget, step: Step): Promise<void> {
  await publishFocusImageUploadEvent(getStreamRedis(), {
    type: FOCUS_IMAGE_UPLOAD_EVENT_TYPE,
    docName: canvasSpaceDocName(target.projectId, target.focusImage.spaceId),
    nodeId: target.focusImage.nodeId,
    ...step,
  });
}

/**
 * Show the crop as uploading in its node, once its grant is open, with the upload's deadline: like a task row it
 * carries its own budget, which a crop with no node counts from its grant's opening. Every member, the uploader too
 * once its bytes are sent, learns of the wait from it; its loss only hides the wait, so it is the caller's to log.
 * @param target - The pool and the image.
 * @param storageKey - The key its grant was opened on; the grant's opening, by the database's clock, starts the budget.
 * @returns Nothing.
 * @throws {Error} When no grant was opened on the key, or publishing fails.
 */
export async function announceFocusImageUploading(target: FocusImageTarget, storageKey: string): Promise<void> {
  const grant = await findGrantByKey(storageKey);
  if (grant === null) throw new Error(`no upload grant on ${storageKey}`);
  const { id, name, width, height } = target.focusImage;
  const at = grant.createdAt.getTime();
  await publish(target, { state: "uploading", openedAt: at, image: { id, name, width, height, deadlineAt: budgetDeadlineFrom(at) } });
}

/**
 * Hand collab the crop with its registered address; bytes that are not a picture end it as failed, and never reach a
 * pool.
 * @param target - The pool and the image.
 * @param asset - The registered asset.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceFocusImage(
  target: FocusImageTarget,
  asset: Pick<StudioAssetEntity, "fileUrl"> & { kind: string },
): Promise<void> {
  if (asset.kind !== "image") {
    await announceFocusImageFailed(target);
    return;
  }
  const { id, name, width, height } = target.focusImage;
  await publish(target, { state: "completed", image: { id, url: asset.fileUrl, name, width, height } });
}

/**
 * End the crop's upload without an image: its grant was voided, or its asset is gone.
 * @param target - The pool and the image.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceFocusImageFailed(target: FocusImageTarget): Promise<void> {
  await publish(target, { state: "failed", id: target.focusImage.id });
}
