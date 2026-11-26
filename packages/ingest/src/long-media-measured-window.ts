// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** An exact time in seconds: an integer numerator over a positive integer denominator, as decimal text. */
export interface MeasuredTime { numerator: string; denominator: string }

/**
 * The window one stream covers, measured by the long-media Container when FFprobe reports no stream duration (Matroska
 * writes none): the video from its packets, the audio from its decoded frames.
 */
export interface MeasuredStreamWindow { index: number; start: MeasuredTime; end: MeasuredTime }

/**
 * Read one exact time.
 * @param value - A JSON value.
 * @returns The time, or null when it is not one.
 */
function measuredTime(value: unknown): MeasuredTime | null {
  if (typeof value !== "object" || value === null) return null;
  const { numerator, denominator } = value as Record<string, unknown>;
  if (typeof numerator !== "string" || !/^-?\d+$/.test(numerator)) return null;
  if (typeof denominator !== "string" || !/^\d+$/.test(denominator) || BigInt(denominator) === 0n) return null;
  return { numerator, denominator };
}

/**
 * Validate the measured windows a Container reports beside FFprobe's output.
 * @param value - The report's `measured` field.
 * @returns The windows, or null when any entry is malformed, repeats a stream or does not end after it starts.
 */
export function parseMeasuredStreamWindows(value: unknown): MeasuredStreamWindow[] | null {
  if (!Array.isArray(value)) return null;
  const windows: MeasuredStreamWindow[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { index } = entry as Record<string, unknown>;
    const start = measuredTime((entry as Record<string, unknown>).start);
    const end = measuredTime((entry as Record<string, unknown>).end);
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || start === null || end === null) return null;
    if (windows.some((window) => window.index === index)) return null;
    if (BigInt(end.numerator) * BigInt(start.denominator) <= BigInt(start.numerator) * BigInt(end.denominator)) return null;
    windows.push({ index, start, end });
  }
  return windows;
}
