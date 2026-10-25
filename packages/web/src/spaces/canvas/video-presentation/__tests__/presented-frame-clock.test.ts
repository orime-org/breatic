// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createPresentedFrameClock } from '../presented-frame-clock';

// Independent expected: approved canvas design section 20, inner#1306.
describe('actual presented-frame identity', () => {
  it('does not treat currentTime or seeked as a newly drawn frame', () => {
    const element = document.createElement('video');
    const clock = createPresentedFrameClock(element, element, 'canonical-a', 4);
    element.currentTime = 0.7;
    element.dispatchEvent(new Event('seeked'));
    expect(clock.getFrame()).toBeNull();
    clock.commit(0.6, clock.getSeekEpoch());
    expect(clock.getFrame()).toEqual({ sourceKey: 'canonical-a', sourceEpoch: 4, seekEpoch: 0, mediaTime: 0.6, surface: element });
    clock.dispose();
  });

  it('immediately clears a frame on seek and rejects the previous seek callback', () => {
    const element = document.createElement('video');
    const clock = createPresentedFrameClock(element, element, 'canonical-a', 4);
    const first = clock.getSeekEpoch();
    clock.commit(0.1, first);
    const second = clock.invalidate();
    expect(clock.getFrame()).toBeNull();
    clock.commit(0.1, first);
    expect(clock.getFrame()).toBeNull();
    clock.commit(0.7, second);
    expect(clock.getFrame()).toEqual({ sourceKey: 'canonical-a', sourceEpoch: 4, seekEpoch: second, mediaTime: 0.7, surface: element });
    clock.dispose();
  });

  it('invalidates when external native controls begin seeking and stops after disposal', () => {
    const element = document.createElement('video');
    const clock = createPresentedFrameClock(element, element, 'canonical-a', 4);
    clock.commit(0.2, 0);
    element.dispatchEvent(new Event('seeking'));
    expect(clock.getFrame()).toBeNull();
    expect(clock.getSeekEpoch()).toBe(1);
    clock.commit(0.7, 1);
    clock.dispose();
    clock.commit(0.2, 1);
    expect(clock.getFrame()).toBeNull();
  });
  it('accepts only the latest seek epoch across rapid seeks', () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 7200, noNaN: true }), { minLength: 3, maxLength: 20 }), (times) => {
      const element = document.createElement('video');
      const clock = createPresentedFrameClock(element, element, 'canonical-a', 4);
      const queued = times.map((time) => ({ time, epoch: clock.invalidate() }));
      for (const prior of queued.slice(0, -1).reverse()) clock.commit(prior.time, prior.epoch);
      expect(clock.getFrame()).toBeNull();
      const last = queued.at(-1)!;
      clock.commit(last.time, last.epoch);
      expect(clock.getFrame()?.mediaTime).toBe(last.time);
      expect(clock.getFrame()?.seekEpoch).toBe(last.epoch);
      clock.dispose();
    }));
  });

});
