// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { getLocale } from '@breatic/shared';
import type { useTranslation } from '@web/i18n/use-translation';
import type { ModelImportBudget, ModelImportErrorCode, ModelImportLimit } from '@web/spaces/three-d/model-import-errors';

const BYTE_LIMITS: ReadonlySet<ModelImportLimit> = new Set(['input', 'expanded', 'entryJson', 'artifact', 'textureBytes']);

/**
 * State an exceeded import limit with the measured value, sizes in megabytes to one decimal: the measured size rounded up and the allowed size rounded down.
 * @param t - The current translator.
 * @param budget - The exceeded limit and both values.
 * @returns The localized sentence.
 * @throws {never} Never.
 */
export function budgetText(t: ReturnType<typeof useTranslation>, budget: ModelImportBudget): string {
  const format = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 });
  /**
   * Show a measured value in the unit its limit uses.
   * @param value - Bytes, a count or pixels.
   * @param round - Rounds a megabyte size to one decimal in the direction that keeps the comparison true.
   * @returns The formatted number.
   * @throws {never} Never.
   */
  const size = (value: number, round: (value: number) => number): string =>
    format.format(BYTE_LIMITS.has(budget.limit) ? round(value / 1024 / 1024 * 10) / 10 : value);
  return t(`spaces.threeD.importModel.limit.${budget.limit}`, { actual: size(budget.actual, Math.ceil), allowed: size(budget.allowed, Math.floor) });
}

const ERROR_KEYS: Readonly<Record<ModelImportErrorCode, string>> = {
  missing: 'spaces.threeD.importModel.errorMissing',
  entry: 'spaces.threeD.importModel.errorEntry',
  unsupported: 'spaces.threeD.importModel.errorUnsupported',
  empty: 'spaces.threeD.importModel.errorEmpty',
  budget: 'spaces.threeD.importModel.errorBudget',
  invalid: 'spaces.threeD.importModel.errorInvalid',
  duplicate: 'spaces.threeD.importModel.errorDuplicate',
};

/**
 * Name the sentence that states a model failure's cause.
 * @param code - The failure code.
 * @returns The locale key.
 * @throws {never} Never.
 */
export function importErrorKey(code: ModelImportErrorCode): string {
  return ERROR_KEYS[code];
}
