// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  ITEM_SLUG_BOUNDS,
  STUDIO_SLUG_BOUNDS,
  itemSlugFromName,
  validateItemSlug,
  validateSlugShape,
  validateStudioSlug,
} from '@web/pages/studio/container/dialogs/slug-util';

describe('validateSlugShape', () => {
  const cases: ReadonlyArray<[string, 'format' | 'length' | null]> = [
    ['my-project', null],
    ['abcdef', null],
    ['My-Project', 'format'], // uppercase
    ['my_project', 'format'], // underscore
    ['-abc-def', 'format'], // leading hyphen
    ['abc-', 'format'], // trailing hyphen
    ['1abc', 'format'], // starts with a digit
    ['a--b', 'format'], // double hyphen
    ['ab', 'length'], // well-formed but too short
    ['a'.repeat(60), 'length'], // well-formed but too long (> 50)
  ];

  it.each(cases)('shape(%s) → %s', (value, expected) => {
    expect(validateSlugShape(value, ITEM_SLUG_BOUNDS)).toBe(expected);
  });

  it('enforces the shorter studio max (39) vs item max (50)', () => {
    const slug = 'a'.repeat(45); // well-formed, 45 chars
    expect(validateSlugShape(slug, STUDIO_SLUG_BOUNDS)).toBe('length');
    expect(validateSlugShape(slug, ITEM_SLUG_BOUNDS)).toBeNull();
  });
});

describe('validateStudioSlug (globally unique)', () => {
  const taken = new Set(['acme-studio']);

  it('passes a fresh, well-formed, non-reserved slug', () => {
    expect(validateStudioSlug('nova-lab', taken)).toBeNull();
  });

  it('rejects a reserved slug', () => {
    expect(validateStudioSlug('studio', taken)).toBe('reserved');
  });

  it('rejects an already-taken slug', () => {
    expect(validateStudioSlug('acme-studio', taken)).toBe('taken');
  });

  it('reports a malformed slug before reserved / taken', () => {
    expect(validateStudioSlug('Acme', taken)).toBe('format');
  });
});

describe('validateItemSlug (not unique — shape only)', () => {
  it('passes any well-formed slug regardless of existing names', () => {
    expect(validateItemSlug('shared-name')).toBeNull();
  });

  it('rejects a malformed slug', () => {
    expect(validateItemSlug('Bad_Slug')).toBe('format');
  });
});

describe('itemSlugFromName (inner#1463)', () => {
  it.each([
    ['Spring Campaign 2026', 'spring-campaign-2026'],
    ['Café déjà vu', 'cafe-deja-vu'],
    ['  My   App!!  ', 'my-app'],
    ['2026 launch plan', 'launch-plan'],
    ['我的项目', 'project'],
    ['プロジェクト', 'project'],
    ['🎨🚀', 'project'],
    ['AI 短片', 'project'],
    ['', 'project'],
  ])('turns %j into %j', (name, expected) => {
    expect(itemSlugFromName(name, 'project')).toBe(expected);
  });

  it('uses the given fallback word', () => {
    expect(itemSlugFromName('资产集', 'collection')).toBe('collection');
  });

  it('cuts a long result at a hyphen within the length limit', () => {
    const name = 'the quick brown fox jumps over the lazy dog again and again';
    const slug = itemSlugFromName(name, 'project');
    expect(slug.length).toBeLessThanOrEqual(ITEM_SLUG_BOUNDS.max);
    expect(name.toLowerCase().replace(/ /g, '-').startsWith(slug)).toBe(true);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('always produces a slug the create endpoint accepts', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 120 }), (name) => {
        expect(validateItemSlug(itemSlugFromName(name, 'project'))).toBeNull();
        expect(validateItemSlug(itemSlugFromName(name, 'collection'))).toBeNull();
      }),
      { numRuns: 500 },
    );
  });
});
