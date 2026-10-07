// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every message the mini-tool registry names is in every catalog (inner#888
 * §7.1). The registry holds keys as data, so the missing-key check, which
 * reads only keys spelled out inside a `t(...)` call, never sees them.
 */

import { describe, it, expect } from 'vitest';
import { MINI_TOOLS, isModelTool, localParamLabelKey } from '@breatic/shared';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/**
 * Every message key one tool's declaration names.
 * @param tool - The declaration.
 * @returns Its label, slot banners, prompt placeholder, and a local tool's
 *   param labels and option labels.
 */
function keysOf(tool: (typeof MINI_TOOLS)[number]): string[] {
  const keys = [tool.labelKey, ...tool.slots.map((slot) => slot.bannerKey)];
  if (tool.prompt !== undefined) keys.push(tool.prompt.placeholderKey);
  if (isModelTool(tool)) return keys;
  for (const param of tool.params) {
    keys.push(localParamLabelKey(param.key));
    if (param.kind !== 'enum') continue;
    for (const option of param.options) {
      if (option.labelKey !== undefined) keys.push(option.labelKey);
    }
  }
  return keys;
}

describe('the mini-tool registry names only messages the catalogs answer', () => {
  it.each(MINI_TOOLS.map((tool) => [tool.id, tool] as const))('%s', (_id, tool) => {
    for (const key of keysOf(tool)) {
      for (const [tag, catalog] of LOCALE_CATALOGS) {
        expect(typeof readPath(catalog, key), `${tag} has no message at ${key}`).toBe('string');
      }
    }
  });
});
