// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One upstream contract: `basePrice` in millionths of a USD, a JSONata `formula`
 * (empty means a flat `basePrice` per call), `discountRate` in percent.
 */
export interface PriceContract {
  readonly basePrice: number;
  readonly formula: string;
  readonly discountRate: number;
}

/**
 * Price one request on one contract.
 * @param contract - The contract.
 * @param fields - The request in the upstream's field names.
 * @param durations - Clip lengths in seconds, keyed by upstream field, for `get_duration`.
 * @returns USD after the discount.
 * @throws {Error} When the formula does not produce a finite `total_price`.
 */
export async function priceUsd(
  contract: PriceContract,
  fields: Readonly<Record<string, unknown>>,
  durations: Readonly<Record<string, readonly number[]>>,
): Promise<number> {
  void contract; void fields; void durations;
  throw new Error("priceUsd is not implemented");
}
