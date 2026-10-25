// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A half-open interval on the source media timeline, in integer microseconds. */
export interface MediaCoreInterval {
  /** Inclusive source-time start, encoded as an integer string for JSON safety. */
  startUs: string;
  /** Exclusive source-time end, encoded as an integer string for JSON safety. */
  endUs: string;
}

/** A core range and the wider source range a decoder may need to read. */
export interface MediaDecodeWindow {
  /** The disjoint interval whose result contributes coverage. */
  core: MediaCoreInterval;
  /** The overlapped interval decoded to provide boundary context. */
  decode: MediaCoreInterval;
}

/** A selected manifest leaf tied to one independently covered media input. */
export interface MediaManifestLeaf extends MediaCoreInterval {
  /** Stable identity of this selected leaf in the manifest revision. */
  id: string;
  /** Stable identity of the required source stream or channel. */
  mediaInputId: string;
}

/** One immutable ordered manifest snapshot. */
export interface MediaManifestSnapshot {
  /** Monotonically increasing snapshot revision. */
  revision: number;
  /** The selected leaves in deterministic source order. */
  leaves: readonly MediaManifestLeaf[];
}

/** A compare-and-set replacement of one active leaf by complete children. */
export interface MediaManifestLeafReplacement {
  /** Snapshot revision the caller planned against. */
  expectedRevision: number;
  /** Active leaf whose coverage is being repartitioned. */
  parentLeafId: string;
  /** Ordered children that must cover the exact parent interval. */
  children: readonly MediaManifestLeaf[];
}

/** Measured local output window and its source timeline origins. */
export interface MediaLocalTimeMapping {
  /** Source-timeline timestamp corresponding to the output timeline origin. */
  sourceOriginUs: string;
  /** Timestamp origin used by the encoded output clip. */
  outputTimelineOriginUs: string;
  /** First local output timestamp admitted for event mapping. */
  outputStartUs: string;
  /** Exclusive local output timestamp end. */
  outputEndUs: string;
  /** Model or transcript event timestamp in the output's local timeline. */
  localTimeUs: string;
}

/**
 * Bisect one source-time core without changing its covered time range.
 * @param core - The half-open source-time interval to split.
 * @returns The adjacent left and right child cores.
 * @throws {RangeError} when the interval is malformed or narrower than two microseconds.
 */
export function bisectMediaCore(core: MediaCoreInterval): [MediaCoreInterval, MediaCoreInterval] {
  const startUs = integerUs(core.startUs);
  const endUs = integerUs(core.endUs);
  const widthUs = endUs - startUs;
  if (widthUs < 2n) throw new RangeError("A media core needs at least two microseconds to bisect.");

  const middleUs = startUs + widthUs / 2n;
  return [
    { startUs: String(startUs), endUs: String(middleUs) },
    { startUs: String(middleUs), endUs: String(endUs) },
  ];
}

/**
 * Expand a core by decode overlap while keeping it inside the source range.
 * @param core - The half-open interval whose result counts toward coverage.
 * @param source - The available half-open source interval.
 * @param overlapUs - The non-negative overlap on each side, as decimal microseconds.
 * @returns The unchanged core and its clamped decode interval.
 * @throws {RangeError} when an interval is invalid, outside the source, or overlap is negative.
 */
export function expandMediaDecodeWindow(
  core: MediaCoreInterval,
  source: MediaCoreInterval,
  overlapUs: string,
): MediaDecodeWindow {
  const coreStartUs = integerUs(core.startUs);
  const coreEndUs = integerUs(core.endUs);
  const sourceStartUs = integerUs(source.startUs);
  const sourceEndUs = integerUs(source.endUs);
  const overlap = integerUs(overlapUs);
  if (sourceEndUs <= sourceStartUs || coreEndUs <= coreStartUs || overlap < 0n) {
    throw new RangeError("Media source, core, and overlap ranges must be valid.");
  }
  if (coreStartUs < sourceStartUs || coreEndUs > sourceEndUs) {
    throw new RangeError("A media core must be inside its source range.");
  }

  return {
    core: { startUs: String(coreStartUs), endUs: String(coreEndUs) },
    decode: {
      startUs: String(coreStartUs - overlap > sourceStartUs ? coreStartUs - overlap : sourceStartUs),
      endUs: String(coreEndUs + overlap < sourceEndUs ? coreEndUs + overlap : sourceEndUs),
    },
  };
}

/**
 * Build a successor manifest revision by replacing one leaf with full-coverage children.
 * @param current - The immutable current snapshot.
 * @param replacement - The expected revision, parent and ordered child leaves.
 * @returns A new snapshot; the current snapshot and its leaves remain unchanged.
 * @throws {RangeError} when the revision is stale or children do not exactly cover the parent input and interval.
 */
export function replaceMediaManifestLeaf(
  current: MediaManifestSnapshot,
  replacement: MediaManifestLeafReplacement,
): MediaManifestSnapshot {
  if (!Number.isSafeInteger(current.revision) || current.revision < 0 || replacement.expectedRevision !== current.revision) {
    throw new RangeError("The media manifest revision changed before replacement.");
  }
  const parentIndex = current.leaves.findIndex((leaf) => leaf.id === replacement.parentLeafId);
  const parent = current.leaves[parentIndex];
  if (parent === undefined || replacement.children.length < 2) {
    throw new RangeError("A manifest replacement needs an active parent and at least two children.");
  }

  const parentStartUs = integerUs(parent.startUs);
  const parentEndUs = integerUs(parent.endUs);
  let previousEndUs = parentStartUs;
  for (const child of replacement.children) {
    const childStartUs = integerUs(child.startUs);
    const childEndUs = integerUs(child.endUs);
    if (
      child.mediaInputId !== parent.mediaInputId ||
      childStartUs !== previousEndUs ||
      childEndUs <= childStartUs
    ) {
      throw new RangeError("Manifest children must be ordered, contiguous, and belong to the parent's media input.");
    }
    previousEndUs = childEndUs;
  }
  if (previousEndUs !== parentEndUs) {
    throw new RangeError("Manifest children must cover the parent's complete core interval.");
  }

  const leaves = [
    ...current.leaves.slice(0, parentIndex),
    ...replacement.children,
    ...current.leaves.slice(parentIndex + 1),
  ];
  if (new Set(leaves.map((leaf) => leaf.id)).size !== leaves.length) {
    throw new RangeError("Manifest leaf ids must be unique within a revision.");
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("The media manifest revision cannot be incremented safely.");
  }
  return { revision: current.revision + 1, leaves };
}

/**
 * Map an output-local timestamp onto the measured original source timeline.
 * @param mapping - Source/output origins and the measured output bounds.
 * @returns The exact source timestamp in decimal microseconds.
 * @throws {RangeError} when timestamps are malformed or the local event is outside the measured output window.
 */
export function mapMediaLocalTimeToSource(mapping: MediaLocalTimeMapping): string {
  const sourceOriginUs = integerUs(mapping.sourceOriginUs);
  const outputTimelineOriginUs = integerUs(mapping.outputTimelineOriginUs);
  const outputStartUs = integerUs(mapping.outputStartUs);
  const outputEndUs = integerUs(mapping.outputEndUs);
  const localTimeUs = integerUs(mapping.localTimeUs);
  if (outputEndUs <= outputStartUs || localTimeUs < outputStartUs || localTimeUs >= outputEndUs) {
    throw new RangeError("A media event timestamp must fall inside its measured output window.");
  }
  return String(sourceOriginUs + localTimeUs - outputTimelineOriginUs);
}

/**
 * Parse a decimal integer timestamp without passing through floating point.
 * @param value - The wire representation of integer microseconds.
 * @returns The exact integer value.
 * @throws {RangeError} when the value is not a decimal integer string.
 */
function integerUs(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) throw new RangeError("Media timestamps must be decimal integer strings.");
  return BigInt(value);
}
