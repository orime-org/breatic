// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Announcing a picture stored for a 3D object's part (inner#1693 design 6.3).
 *
 * The browser only sends the bytes. Once they are stored (or the studio
 * already held them), the server tells collab which part the upload started
 * from and the picture that part held then; collab writes the new picture
 * there when it still may and tells the uploader otherwise. This is the same
 * road a canvas upload takes to its node.
 */

import { getStreamRedis, publishNodeEvent } from "@breatic/core";
import { threeDSpaceDocName } from "@breatic/shared";
import type { SceneLookTarget } from "@domain/asset/upload-grant.repo.js";

/**
 * Publish the stored picture for collab to put on its part.
 *
 * The event is the only way the picture reaches the part, so a failure to
 * publish fails the caller: the report is finished again, or the ticket
 * request answers an error and the user picks the file again.
 * @param params - Where the picture goes and who uploaded it.
 * @param params.projectId - The project.
 * @param params.spaceId - The 3D Space.
 * @param params.target - The object, the part and the part's picture at the start.
 * @param params.picture - The stored picture's asset id.
 * @param params.userId - Who uploaded it.
 * @param params.uploadKey - Names this upload once, so collab applies a repeat of it once.
 * @throws {Error} When Redis rejects the publish.
 */
export async function emitSceneLookPicture(params: {
  projectId: string;
  spaceId: string;
  target: SceneLookTarget;
  picture: string;
  userId: string;
  uploadKey: string;
}): Promise<void> {
  await publishNodeEvent(getStreamRedis(), {
    type: "scene-look-picture",
    docName: threeDSpaceDocName(params.projectId, params.spaceId),
    objectId: params.target.objectId,
    part: params.target.part,
    startMap: params.target.startMap,
    picture: params.picture,
    userId: params.userId,
    uploadKey: params.uploadKey,
  });
}
