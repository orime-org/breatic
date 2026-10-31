// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The app shell's description is what a search result or a shared link shows
 * under the page title, so it carries the product's positioning line
 * (operations repo, strategy/slogan.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');

describe('the app shell head', () => {
  it('describes Breatic by its positioning line', () => {
    const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
    expect(description).toBe('Breatic - The real-time collaborative AI workspace for creative teams');
  });
});
