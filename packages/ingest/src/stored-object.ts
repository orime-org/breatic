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

/** Why a stream could not be written as parts. */
export type StreamRefusal = "over_cap";

/**
 * Write a stream into an open multipart upload, one part at a time.
 *
 * This is how bytes we fetched ourselves reach R2 (#181, lane ③). A single
 * `put` is not available for them: workerd refuses a stream whose length it
 * does not know ("Provided readable stream must have a known length"), and
 * whether the source declares one is the source's choice, not ours — a chunked
 * or transcoded response declares none. Filling fixed-size parts sidesteps the
 * question, and it is the same write path the browser's upload already uses.
 *
 * `maxParts` is the ceiling the ticket signed. It exists because nothing else
 * bounds this: the browser announces how many parts it will send, while a URL
 * announces nothing, so without it a source that never ends fills the bucket.
 * @param bucket - The bucket the upload writes to.
 * @param storageKey - The key it writes to.
 * @param uploadId - R2's id for the multipart upload.
 * @param body - The bytes to write.
 * @param partSize - How large each part but the last should be.
 * @param maxParts - The most parts this upload may take.
 * @returns The parts R2 accepted, or why the write was refused.
 * @throws {Error} When reading the source or writing a part fails.
 */
export async function writeStreamAsParts(
  bucket: R2Bucket,
  storageKey: string,
  uploadId: string,
  body: ReadableStream<Uint8Array>,
  partSize: number,
  maxParts: number,
): Promise<RecordedPart[] | StreamRefusal> {
  const upload = bucket.resumeMultipartUpload(storageKey, uploadId);
  const reader = body.getReader();
  const parts: RecordedPart[] = [];
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;

  /**
   * Take exactly this many bytes off the front of what is held.
   *
   * A read hands back whatever arrived, which is never the part size, so the
   * boundary falls inside a chunk and the rest of it starts the next part —
   * R2 refuses any part but the last under its floor.
   * @param size - How many bytes to take.
   * @returns Those bytes, contiguous.
   */
  const take = (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = pending[0]!;
      const room = size - at;
      if (chunk.length <= room) {
        out.set(chunk, at);
        at += chunk.length;
        pending.shift();
      } else {
        out.set(chunk.subarray(0, room), at);
        pending[0] = chunk.subarray(room);
        at = size;
      }
    }
    pendingBytes -= size;
    return out;
  };

  /**
   * Write the next part.
   * @param bytes - What it holds.
   * @returns Nothing.
   */
  const writePart = async (bytes: Uint8Array): Promise<void> => {
    const written = await upload.uploadPart(parts.length + 1, bytes);
    parts.push({ partNumber: parts.length + 1, etag: written.etag });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      while (pendingBytes >= partSize) {
        if (parts.length >= maxParts) return "over_cap";
        await writePart(take(partSize));
      }
    }
  } finally {
    reader.releaseLock();
  }

  // An empty source still gets one part: R2 will not assemble an upload with
  // none, and a zero-byte object is a truthful answer to what was fetched.
  if (pendingBytes > 0 || parts.length === 0) {
    if (parts.length >= maxParts) return "over_cap";
    await writePart(take(pendingBytes));
  }
  return parts;
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
