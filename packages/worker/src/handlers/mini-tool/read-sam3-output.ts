// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The two artifacts returned together by the original SAM3 prediction. */
export interface MiniToolSam3Output { rleURL: string; previewURL: string }

/**
 * Read the paired artifacts from the original structured prediction output.
 * @param outputs - The original prediction's outputs field.
 * @returns The RLE and preview URLs from the same output item.
 * @throws {Error} When that item lacks either nonempty URL field.
 */
export function readMiniToolSam3Output(outputs: unknown): MiniToolSam3Output {
  const first: unknown = Array.isArray(outputs) ? outputs[0] : undefined;
  if (typeof first !== "object" || first === null) throw new Error("SAM3 prediction has no structured artifact pair");
  const pair = first as Record<string, unknown>;
  if (typeof pair.rle_url !== "string" || pair.rle_url === "" || typeof pair.video_url !== "string" || pair.video_url === "") {
    throw new Error("SAM3 prediction requires its paired RLE and preview URLs");
  }
  return { rleURL: pair.rle_url, previewURL: pair.video_url };
}
