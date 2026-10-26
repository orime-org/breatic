// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The two artifacts returned together by the original SAM3 prediction. */
export interface MiniToolSam3Output { rleURL: string; previewURL: string }

/**
 * Read the paired artifacts from the original structured prediction output.
 * @param _outputs - The original prediction's outputs field.
 * @returns The RLE and preview URLs from the same output item.
 * @throws {Error} When that item lacks either nonempty URL field.
 */
export function readMiniToolSam3Output(_outputs: unknown): MiniToolSam3Output {
  throw new Error("SAM3 structured output reader is not implemented");
}
