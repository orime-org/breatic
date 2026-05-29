import { describe, it, expect } from 'vitest';
import * as stores from '@web/stores/index';

describe('stores barrel', () => {
  it('re-exports all 10 store hooks', () => {
    expect(typeof stores.useUIStore).toBe('function');
    expect(typeof stores.usePreferencesStore).toBe('function');
    expect(typeof stores.useCurrentUserStore).toBe('function');
    expect(typeof stores.useCanvasStore).toBe('function');
    expect(typeof stores.useMiniToolStore).toBe('function');
    expect(typeof stores.useInpaintStore).toBe('function');
    expect(typeof stores.useChatStore).toBe('function');
    expect(typeof stores.useStudioStore).toBe('function');
    expect(typeof stores.useProjectStore).toBe('function');
    expect(typeof stores.useToastStore).toBe('function');
  });
});
