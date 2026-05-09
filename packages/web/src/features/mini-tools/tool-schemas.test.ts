/**
 * F4-framework — tool-schemas tests.
 *
 * Lock down the helpers consumed by `MiniToolContext` and the
 * BottomToolbar control mapping. The schema list itself is
 * defensively tested only for invariants the UI relies on (every
 * row has unique id; `default` lives within the param's domain).
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_TOOLS,
  defaultValues,
  findToolSchema,
} from './tool-schemas';

describe('tool-schemas — IMAGE_TOOLS invariants', () => {
  it('every row has a unique id', () => {
    const ids = IMAGE_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every modality is image (per F4-framework scope)', () => {
    for (const t of IMAGE_TOOLS) {
      expect(t.modality).toBe('image');
    }
  });

  it('select param defaults are in the options list', () => {
    for (const t of IMAGE_TOOLS) {
      for (const p of t.params) {
        if (p.ui === 'select') {
          expect(p.options).toContain(p.default);
        }
      }
    }
  });

  it('slider param defaults are within [min, max]', () => {
    for (const t of IMAGE_TOOLS) {
      for (const p of t.params) {
        if (p.ui === 'slider') {
          expect(p.default).toBeGreaterThanOrEqual(p.min);
          expect(p.default).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });
});

describe('findToolSchema', () => {
  it('returns the schema for a known id', () => {
    const t = findToolSchema('upscale');
    expect(t).not.toBeNull();
    expect(t?.id).toBe('upscale');
  });

  it('returns null for an unknown id', () => {
    expect(findToolSchema('does-not-exist')).toBeNull();
  });
});

describe('defaultValues', () => {
  it('returns an empty object for tools with no params', () => {
    const t = findToolSchema('remove-bg');
    expect(t).not.toBeNull();
    expect(defaultValues(t!)).toEqual({});
  });

  it('returns each param default keyed by id', () => {
    const t = findToolSchema('denoise');
    expect(t).not.toBeNull();
    expect(defaultValues(t!)).toEqual({
      denoise: 0,
      detail: 0,
      face_enhancement: true,
    });
  });
});
