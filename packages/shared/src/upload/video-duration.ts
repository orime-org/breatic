// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Project the decimal value sent to PostgreSQL onto numeric(12,3) precision.
 * @param value - A positive finite measured or registered duration.
 * @returns Exact milliseconds with positive decimal halves rounded away from zero.
 * @throws {never} Unknown or invalid values have no numeric projection.
 */
export function videoDurationMilliseconds(value: number): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (match === null) return null;
  const fraction = match[2] ?? '';
  const digits = BigInt(match[1]! + fraction);
  const shift = Number(match[3] ?? 0) - fraction.length + 3;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (digits + divisor / 2n) / divisor;
}

/**
 * Compare canonical duration facts at the registry's actual decimal precision.
 * @param measured - Trusted probe or previously published duration.
 * @param registered - A stored registry constraint or another trusted measurement.
 * @returns Whether both valid decimal values project to the same stored duration.
 * @throws {never} Missing or invalid facts never compare equal.
 */
export function videoDurationsMatch(measured: number, registered: number): boolean {
  const left = videoDurationMilliseconds(measured);
  const right = videoDurationMilliseconds(registered);
  return left !== null && right !== null && left === right;
}
