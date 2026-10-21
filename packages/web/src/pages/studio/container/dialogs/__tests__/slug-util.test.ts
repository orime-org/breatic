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

  it('cuts at the last hyphen when the limit falls inside a word', () => {
    const name = 'alpha beta gamma delta epsilon zeta eta theta iotas kappa';
    expect(itemSlugFromName(name, 'project')).toBe('alpha-beta-gamma-delta-epsilon-zeta-eta-theta');
  });

  it('keeps a word that ends exactly at the limit', () => {
    const name = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    expect(itemSlugFromName(name, 'project')).toBe('alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota');
  });

  it('cuts a single word longer than the limit at the limit', () => {
    expect(itemSlugFromName('a'.repeat(70), 'project')).toBe('a'.repeat(ITEM_SLUG_BOUNDS.max));
  });

  it('keeps whole words of a Latin name, cutting only at a word end', () => {
    const word = fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 12 }), (words) => {
        const full = words.join('-');
        const slug = itemSlugFromName(words.join(' '), 'project');
        if (full.length < ITEM_SLUG_BOUNDS.min) {
          expect(slug).toBe('project');
        } else if (full.length <= ITEM_SLUG_BOUNDS.max) {
          expect(slug).toBe(full);
        } else {
          const lastBreak = full.slice(0, ITEM_SLUG_BOUNDS.max + 1).lastIndexOf('-');
          expect(slug).toBe(
            lastBreak >= ITEM_SLUG_BOUNDS.min ? full.slice(0, lastBreak) : full.slice(0, ITEM_SLUG_BOUNDS.max),
          );
        }
      }),
      { numRuns: 500 },
    );
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
