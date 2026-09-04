// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning an upload's parts into the object R2 holds (#186, design §6.2).
 *
 * Both steps run in the Worker. The instance holding the upload's bookkeeping
 * touches metadata only — it is billed for wall-clock time against a fixed
 * 128 MB, so reading a multi-gigabyte object back inside one is paid for at
 * that rate for as long as the read takes, while a Worker waiting on I/O is
 * not billed for the wait at all. What reaches the instance is the two facts
 * these produce.
 */

/** A part R2 has accepted, in the form completing the upload needs back. */
export interface RecordedPart {
  partNumber: number;
  etag: string;
}

/**
 * Assemble the object from the parts R2 accepted.
 *
 * An attempt that assembled and then died leaves R2 holding the object while
 * the instance has no record of it, and R2 answers the second assembly the
 * same way it answers one for an upload that was never opened: "the specified
 * multipart upload does not exist". The object being there is what tells those
 * two apart, so a failure asks R2 whether it already did this.
 * @param bucket - The bucket the upload writes to.
 * @param storageKey - The key it writes to.
 * @param uploadId - R2's id for the multipart upload.
 * @param parts - Every part that landed, in any order.
 * @returns What the assembled object weighs.
 * @throws {Error} When R2 refused and no object stands at that key.
 */
export async function assembleObject(
  bucket: R2Bucket,
  storageKey: string,
  uploadId: string,
  parts: RecordedPart[],
): Promise<number> {
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  try {
    const object = await bucket
      .resumeMultipartUpload(storageKey, uploadId)
      .complete(ordered);
    return object.size;
  } catch (err) {
    const stored = await bucket.head(storageKey);
    if (stored === null) throw err;
    return stored.size;
  }
}

/**
 * Hash the object R2 assembled.
 *
 * Streamed rather than buffered: an upload may be gigabytes, and the read
 * stays inside Cloudflare's network where it costs nothing.
 * @param bucket - The bucket holding it.
 * @param storageKey - The assembled object's key.
 * @returns Its SHA-256 as lowercase hex.
 * @throws {Error} When the object is not readable.
 */
export async function hashStoredObject(
  bucket: R2Bucket,
  storageKey: string,
): Promise<string> {
  const stored = await bucket.get(storageKey);
  if (stored === null) throw new Error(`completed object ${storageKey} is missing`);
  const digestStream = new crypto.DigestStream("SHA-256");
  await stored.body.pipeTo(digestStream);
  const digest = await digestStream.digest;
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
