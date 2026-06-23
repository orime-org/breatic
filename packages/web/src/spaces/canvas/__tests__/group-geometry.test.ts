// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  rectContainsPoint,
  groupContainsMemberCenter,
  toRelativePosition,
  toAbsolutePosition,
  groupRectForMembers,
  expandGroupToWrap,
  planGroupGrowth,
  groupResizeBounds,
  GROUP_PADDING,
} from '@web/spaces/canvas/group-geometry';

/**
 * Deterministic PRNG so the only-expand invariant runs over many random
 * inputs without `Math.random` flake (reproducible failures).
 * @param seed - Seed value.
 * @returns A function yielding floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('rectContainsPoint', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  it('true for an interior point', () => {
    expect(rectContainsPoint(rect, { x: 50, y: 50 })).toBe(true);
  });
  it('true on the edge (inclusive)', () => {
    expect(rectContainsPoint(rect, { x: 0, y: 100 })).toBe(true);
  });
  it('false outside the rect', () => {
    expect(rectContainsPoint(rect, { x: 150, y: 50 })).toBe(false);
  });
});

describe('groupContainsMemberCenter', () => {
  const group = { x: 0, y: 0, width: 200, height: 200 };
  it('stays inside when the center is in even though the body sticks out', () => {
    // member 100x100 at (150,150): right/bottom reach 250 (outside the group),
    // but the center at (200,200) sits on the group edge → still inside.
    expect(
      groupContainsMemberCenter(group, { x: 150, y: 150, width: 100, height: 100 }),
    ).toBe(true);
  });
  it('leaves when the center crosses the group edge', () => {
    // center at (260,100) is past the right edge → out of the Group.
    expect(
      groupContainsMemberCenter(group, { x: 210, y: 50, width: 100, height: 100 }),
    ).toBe(false);
  });
});

describe('coordinate conversion', () => {
  it('toRelativePosition subtracts the parent top-left', () => {
    expect(toRelativePosition({ x: 130, y: 140 }, { x: 100, y: 100 })).toEqual({
      x: 30,
      y: 40,
    });
  });
  it('toAbsolutePosition adds the parent top-left', () => {
    expect(toAbsolutePosition({ x: 30, y: 40 }, { x: 100, y: 100 })).toEqual({
      x: 130,
      y: 140,
    });
  });
  it('round-trips abs → rel → abs', () => {
    const abs = { x: 73, y: -12 };
    const parent = { x: 40, y: 55 };
    expect(toAbsolutePosition(toRelativePosition(abs, parent), parent)).toEqual(abs);
  });
});

describe('groupRectForMembers', () => {
  it('null for no members', () => {
    expect(groupRectForMembers([])).toBeNull();
  });
  it('bounding box + padding on every side', () => {
    const members = [
      { x: 100, y: 100, width: 50, height: 50 }, // x 100..150, y 100..150
      { x: 200, y: 180, width: 40, height: 40 }, // x 200..240, y 180..220
    ];
    expect(groupRectForMembers(members, 24)).toEqual({
      x: 76,
      y: 76,
      width: 240 - 100 + 48,
      height: 220 - 100 + 48,
    });
  });
  it('defaults to GROUP_PADDING', () => {
    const r = groupRectForMembers([{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(r).toEqual({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING,
      width: 10 + 2 * GROUP_PADDING,
      height: 10 + 2 * GROUP_PADDING,
    });
  });
});

describe('expandGroupToWrap (only-expand, never shrink; keeps GROUP_PADDING)', () => {
  const group = { x: 0, y: 0, width: 200, height: 200 };
  it('returns the group unchanged when every member already has ≥ padding inside', () => {
    // member 50..100 sits ≥ 24px inside the 0..200 group on every side → no growth.
    expect(expandGroupToWrap(group, [{ x: 50, y: 50, width: 50, height: 50 }])).toEqual(
      group,
    );
  });
  it('expands to wrap a member overflowing right/bottom, leaving 24px padding', () => {
    // member reaches 250; the group grows to 250 + 24 = 274 so the member keeps 24px.
    expect(
      expandGroupToWrap(group, [{ x: 150, y: 150, width: 100, height: 100 }]),
    ).toEqual({ x: 0, y: 0, width: 274, height: 274 });
  });
  it('expands left/up with 24px padding and keeps the far edges', () => {
    // member left/top at -50/-30 → group grows to -74/-54 (member - 24); far edges stay 200.
    expect(
      expandGroupToWrap(group, [{ x: -50, y: -30, width: 20, height: 20 }]),
    ).toEqual({ x: -74, y: -54, width: 274, height: 254 });
  });
  it('grows to restore 24px when a member drifts within the padding (no overflow needed)', () => {
    // member right edge at 190 (only 10px from the 200 group edge) → group grows to 214.
    expect(
      expandGroupToWrap(group, [{ x: 150, y: 50, width: 40, height: 40 }]),
    ).toEqual({ x: 0, y: 0, width: 214, height: 200 });
  });
  it('a custom padding of 0 reproduces the exact-wrap (no breathing room)', () => {
    expect(
      expandGroupToWrap(group, [{ x: 150, y: 150, width: 100, height: 100 }], 0),
    ).toEqual({ x: 0, y: 0, width: 250, height: 250 });
  });
  it('clamps a rect that was dragged INSIDE the members back out to 24px (fast-drag commit guard)', () => {
    // A fast resize can release with the Group shrunk so its left edge (x=120)
    // sits inside the member (left=100) — past the hard-stop. Feeding that
    // overshot rect through expandGroupToWrap grows the left back to 100 - 24 =
    // 76 so the member keeps 24px, while the unchanged right edge (200) stays.
    const overshot = { x: 120, y: 0, width: 80, height: 200 }; // right edge 200
    const member = { x: 100, y: 50, width: 60, height: 60 }; // 100..160
    expect(expandGroupToWrap(overshot, [member])).toEqual({
      x: 76, // 100 - 24
      y: 0,
      width: 200 - 76, // right edge stays at 200
      height: 200,
    });
  });
  it('invariant: result contains the original group AND every member padded by 24px (200 random cases)', () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const f = {
        x: rnd() * 100,
        y: rnd() * 100,
        width: 50 + rnd() * 200,
        height: 50 + rnd() * 200,
      };
      const members = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
        x: (rnd() - 0.5) * 400,
        y: (rnd() - 0.5) * 400,
        width: rnd() * 150,
        height: rnd() * 150,
      }));
      const out = expandGroupToWrap(f, members);
      // only-expand: the result never shrinks past the original group
      expect(out.x).toBeLessThanOrEqual(f.x);
      expect(out.y).toBeLessThanOrEqual(f.y);
      expect(out.x + out.width).toBeGreaterThanOrEqual(f.x + f.width);
      expect(out.y + out.height).toBeGreaterThanOrEqual(f.y + f.height);
      // containment WITH padding: every member keeps ≥ GROUP_PADDING to each edge
      for (const m of members) {
        expect(out.x).toBeLessThanOrEqual(m.x - GROUP_PADDING);
        expect(out.y).toBeLessThanOrEqual(m.y - GROUP_PADDING);
        expect(out.x + out.width).toBeGreaterThanOrEqual(
          m.x + m.width + GROUP_PADDING,
        );
        expect(out.y + out.height).toBeGreaterThanOrEqual(
          m.y + m.height + GROUP_PADDING,
        );
      }
    }
  });
});

describe('planGroupGrowth — grow existing groups that gained members (duplicate into a group, R2-A)', () => {
  it('grows a group whose new member sits flush against the border, to restore 24px', () => {
    // group 0..200; member right edge at 200 (flush) → group grows to 200+24=224.
    const out = planGroupGrowth([
      {
        groupId: 'g',
        rect: { x: 0, y: 0, width: 200, height: 200 },
        memberRects: [{ x: 160, y: 50, width: 40, height: 40 }],
      },
    ]);
    expect(out).toEqual([
      { groupId: 'g', position: { x: 0, y: 0 }, width: 224, height: 200 },
    ]);
  });

  it('returns nothing when every member already keeps 24px inside', () => {
    const out = planGroupGrowth([
      {
        groupId: 'g',
        rect: { x: 0, y: 0, width: 200, height: 200 },
        memberRects: [{ x: 50, y: 50, width: 50, height: 50 }],
      },
    ]);
    expect(out).toEqual([]);
  });

  it('only emits the groups that actually grew', () => {
    const out = planGroupGrowth([
      {
        groupId: 'snug',
        rect: { x: 0, y: 0, width: 200, height: 200 },
        memberRects: [{ x: 50, y: 50, width: 50, height: 50 }],
      },
      {
        groupId: 'tight',
        rect: { x: 0, y: 0, width: 200, height: 200 },
        memberRects: [{ x: 50, y: 170, width: 40, height: 40 }],
      },
    ]);
    expect(out).toEqual([
      { groupId: 'tight', position: { x: 0, y: 0 }, width: 200, height: 234 },
    ]);
  });
});

describe('groupResizeBounds — per-control min size so the native clamp keeps members ≥ padding inside', () => {
  // member local bbox (relative to group top-left) well inside a roomy group.
  const box = { x: 40, y: 40, width: 100, height: 60 }; // mLeft40 mTop40 mRight140 mBottom100
  const W = 300;
  const H = 200;

  /**
   * Look up one control's bound from the returned array.
   * @param bounds - The 8 control bounds.
   * @param position - The control position to find.
   * @returns The matching bound.
   */
  function at(
    bounds: ReturnType<typeof groupResizeBounds>,
    position: string,
  ): { minWidth: number; minHeight: number } {
    const b = bounds.find((entry) => entry.position === position);
    if (!b) throw new Error(`no bound for ${position}`);
    return { minWidth: b.minWidth, minHeight: b.minHeight };
  }

  it('returns all 8 controls (4 lines + 4 corners)', () => {
    const bounds = groupResizeBounds(box, W, H, 24, 40);
    expect(bounds.map((b) => b.position).sort()).toEqual(
      [
        'bottom',
        'bottom-left',
        'bottom-right',
        'left',
        'right',
        'top',
        'top-left',
        'top-right',
      ].sort(),
    );
  });

  it('edge controls: each anchors its opposite edge, so the member-side bound is a pure size floor', () => {
    const b = groupResizeBounds(box, W, H, 24, 40);
    // right: left fixed → minWidth = mRight + 24 = 164; height unaffected → floor 40.
    expect(at(b, 'right')).toEqual({ minWidth: 164, minHeight: 40 });
    // left: right fixed → minWidth = W - mLeft + 24 = 300-40+24 = 284.
    expect(at(b, 'left')).toEqual({ minWidth: 284, minHeight: 40 });
    // bottom: top fixed → minHeight = mBottom + 24 = 124.
    expect(at(b, 'bottom')).toEqual({ minWidth: 40, minHeight: 124 });
    // top: bottom fixed → minHeight = H - mTop + 24 = 200-40+24 = 184.
    expect(at(b, 'top')).toEqual({ minWidth: 40, minHeight: 184 });
  });

  it('corner controls combine both edges', () => {
    const b = groupResizeBounds(box, W, H, 24, 40);
    expect(at(b, 'top-left')).toEqual({ minWidth: 284, minHeight: 184 });
    expect(at(b, 'top-right')).toEqual({ minWidth: 164, minHeight: 184 });
    expect(at(b, 'bottom-left')).toEqual({ minWidth: 284, minHeight: 124 });
    expect(at(b, 'bottom-right')).toEqual({ minWidth: 164, minHeight: 124 });
  });

  it('invariant: shrinking to each edge bound leaves the member exactly `padding` inside (right + left)', () => {
    const b = groupResizeBounds(box, W, H, 24, 40);
    // right edge dragged in, left anchored at local 0: new right = minWidth; member right 140 → gap = 164-140 = 24.
    expect(at(b, 'right').minWidth - (box.x + box.width)).toBe(24);
    // left edge dragged in, right anchored at local W: new left = W - minWidth; member left 40 → gap = 40-(300-284) = 24.
    expect(box.x - (W - at(b, 'left').minWidth)).toBe(24);
  });

  it('floors a tiny-member bound at minSize (never below the empty-group floor)', () => {
    // member hugging the origin: mRight = 10, so mRight+24 = 34 < 40 → floored to 40.
    const b = groupResizeBounds({ x: 0, y: 0, width: 10, height: 10 }, 200, 200, 24, 40);
    expect(at(b, 'right').minWidth).toBe(40);
  });

  it('an empty group (no members) floors every control at minSize', () => {
    const b = groupResizeBounds(null, 200, 200, 24, 40);
    for (const entry of b) {
      expect(entry.minWidth).toBe(40);
      expect(entry.minHeight).toBe(40);
    }
  });
});
