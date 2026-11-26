// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** Trusted channel-presence evidence, separate from storage readiness. */
export type VideoAlphaClassification = 'confirmed_alpha' | 'confirmed_opaque' | 'unknown';

/**
 * Read named probe fields without treating malformed values as trusted evidence.
 * @param value - Raw ffprobe JSON.
 * @returns Named fields, or an empty record.
 * @throws {never} Unreadable input supplies no facts.
 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Classify the sole real video using its probe and this FFmpeg build's descriptors.
 * @param probe - Complete raw streams and format facts from the stored source.
 * @param pixelFormats - This bundled ffprobe's actual pixel-format descriptors.
 * @returns Confirmed channel presence, or unknown when evidence is insufficient.
 * @throws {never} Invalid or ambiguous facts remain unknown.
 */
export function classifyVideoAlpha(probe: unknown, pixelFormats: unknown): VideoAlphaClassification {
  const raw = record(probe);
  if (!Array.isArray(raw.streams)) return 'unknown';
  const video = raw.streams.map(record).filter((stream) => stream.codec_type === 'video' && record(stream.disposition).attached_pic !== 1);
  if (video.length !== 1) return 'unknown';
  const selected = video[0]!;
  if (!Number.isSafeInteger(selected.width) || !Number.isSafeInteger(selected.height) || Number(selected.width) <= 0 || Number(selected.height) <= 0) return 'unknown';
  const formats = record(pixelFormats).pixel_formats;
  if (!Array.isArray(formats) || typeof selected.pix_fmt !== 'string') return 'unknown';
  const descriptor = formats.map(record).find((format) => format.name === selected.pix_fmt);
  const hasAlpha = record(descriptor?.flags).alpha;
  if (hasAlpha !== 0 && hasAlpha !== 1) return 'unknown';
  const tags = record(selected.tags);
  const alphaEntries = Object.entries(tags).filter(([key]) => key.toLowerCase() === 'alpha_mode');
  const modes = new Set(alphaEntries.map(([, value]) => value));
  if (modes.size > 1) return 'unknown';
  const alphaMode = alphaEntries[0]?.[1];
  if (alphaMode !== undefined && alphaMode !== '0' && alphaMode !== '1') return 'unknown';
  if (alphaMode === '0' && hasAlpha === 1) return 'unknown';
  if (hasAlpha === 1) return 'confirmed_alpha';
  if (alphaMode === '1') {
    const container = record(raw.format).format_name;
    const matroska = typeof container === 'string' && container.split(',').some((name) => name === 'matroska' || name === 'webm');
    return matroska && (selected.codec_name === 'vp8' || selected.codec_name === 'vp9') ? 'confirmed_alpha' : 'unknown';
  }
  return 'confirmed_opaque';
}
