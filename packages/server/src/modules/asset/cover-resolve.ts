// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Server-side cover-thumbnail resolution for uploaded videos (#1824).
 *
 * An uploaded video's cover is extracted client-side (#1816); the frontend
 * cannot be trusted to hand the server a cover URL, so it sends a verifiable
 * reference — `cover_key` (regular upload) or `cover_hash` (dedup hit) — and
 * the server RE-DERIVES the URL:
 *   - regular: verify the key is owned + the object exists + its storageKey
 *     taskType segment is `image`, then `publicUrl(key)`.
 *   - dedup: look the (studio, hash) row up server-side and read its
 *     storageKey segment; the client URL is never trusted.
 *
 * Kind is judged from the storageKey taskType segment — NOT `head().contentType`
 * (local storage hardcodes `application/octet-stream`) and NOT the ledger
 * `kind` (derived from that same contentType at registration → always `'file'`
 * on local). The segment reflects the presign-time content type and is
 * reliable on every backend.
 *
 * Every path is BEST-EFFORT: any failure (unowned / missing / wrong kind /
 * dedup miss / thrown transport or NotFound error) resolves to `undefined`
 * (the caller degrades to a Film icon) and NEVER throws, so a cover problem
 * can never fail the video upload itself.
 */

/**
 * The taskType (kind) segment of a storage key. Presign builds keys as
 * `{userId}/{projectId}/{taskType}/…`, so the kind lives at split index 2.
 * @param key - A storage key.
 * @returns The taskType segment, or undefined when the key has < 3 segments.
 */
export function kindFromStorageKey(key: string): string | undefined {
  const parts = key.split("/");
  return parts.length >= 3 ? parts[2] : undefined;
}

/** A verifiable cover reference the client may send alongside a video upload. */
export interface CoverResolveInput {
  /** Regular path: the cover's own presigned storage key. */
  coverKey?: string;
  /** Dedup path: the cover's content hash (the cover object already exists). */
  coverHash?: string;
  /** Project the upload targets (for the dedup studio scope). */
  projectId: string;
  /** Authenticated uploader (for the dedup studio scope). */
  actingUserId: string;
}

/** Injected server capabilities — keeps {@link resolveCoverUrl} pure-testable. */
export interface CoverResolveDeps {
  /** Rejects a key not bound to the caller+project or attempting traversal. */
  isOwnedKey: (key: string) => boolean;
  /** Storage existence probe. */
  head: (key: string) => Promise<{ exists: boolean }>;
  /** Storage key → permanent public URL. */
  publicUrl: (key: string) => string;
  /** Server-side (studio, hash) lookup returning the stored asset's ref. */
  verifyDedupUpload: (params: {
    projectId: string;
    actingUserId: string;
    contentHash: string;
  }) => Promise<{ fileUrl: string; storageKey: string } | null>;
}

/**
 * Resolve an uploaded video's cover thumbnail URL from a verifiable client
 * reference. Best-effort: returns undefined (→ Film) on ANY failure and never
 * throws. See the module header for the trust + kind-derivation rationale.
 * @param input - The cover reference + studio scope.
 * @param deps - Injected server capabilities.
 * @returns The server-derived cover URL, or undefined when unresolvable.
 */
export async function resolveCoverUrl(
  input: CoverResolveInput,
  deps: CoverResolveDeps,
): Promise<string | undefined> {
  try {
    if (input.coverKey !== undefined) {
      if (!deps.isOwnedKey(input.coverKey)) return undefined;
      const { exists } = await deps.head(input.coverKey);
      if (!exists) return undefined;
      if (kindFromStorageKey(input.coverKey) !== "image") return undefined;
      return deps.publicUrl(input.coverKey);
    }
    if (input.coverHash !== undefined) {
      const hit = await deps.verifyDedupUpload({
        projectId: input.projectId,
        actingUserId: input.actingUserId,
        contentHash: input.coverHash,
      });
      if (!hit) return undefined;
      if (kindFromStorageKey(hit.storageKey) !== "image") return undefined;
      return hit.fileUrl;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
