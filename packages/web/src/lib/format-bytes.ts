// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning a byte count into something a person reads.
 *
 * Two places show one: the membership panel, whose ceilings arrive exactly as
 * `config/membership.yaml` holds them, and the canvas, which tells a reader
 * how large a file is against the ceiling an understand run will take. Both
 * of those numbers are binary, and both are read by the same person.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * Render a byte count in the largest binary unit that leaves it above one.
 *
 * Binary units and not decimal ones, because the configured values are
 * binary: `5 GiB` in the file is `5 * 1024³`, and calling that "5.4 GB" would
 * print a number nobody wrote. A whole value stays whole (`200 GiB`); a
 * measured one, which usage always is, keeps one decimal (`38.4 GiB`).
 * @param bytes - A non-negative byte count.
 * @returns The count with its unit, for example `200 GiB` or `38.4 GiB`.
 */
export function formatBytes(bytes: number): string {
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  // `Number()` drops a trailing `.0`, so a whole number of GiB reads as the
  // integer somebody configured rather than as a measurement.
  let shown = Number(value.toFixed(1));
  // Rounding can push the figure up to a number its unit does not have:
  // 1048575 bytes is 1023.999 KiB, which rounds to "1024 KiB" — a reading this
  // scale never produces. Carrying it into the next unit is what the promise
  // above ("the largest unit that leaves it above one") actually says.
  if (shown >= 1024 && index < UNITS.length - 1) {
    shown = 1;
    index += 1;
  }
  return `${shown} ${UNITS[index]}`;
}
