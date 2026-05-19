import { describe, it, expect, beforeEach } from 'vitest';
import { useToastStore } from '../toast';

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
  });

  it('initial queue is empty', () => {
    expect(useToastStore.getState().queue).toEqual([]);
  });

  it('push appends entries with createdAt timestamp', () => {
    useToastStore.getState().push({ id: 't1', variant: 'success', message: 'OK' });
    const q = useToastStore.getState().queue;
    expect(q).toHaveLength(1);
    expect(q[0].id).toBe('t1');
    expect(q[0].variant).toBe('success');
    expect(typeof q[0].createdAt).toBe('number');
  });

  it('dismiss removes entry by id; others stay', () => {
    useToastStore.getState().push({ id: 'a', variant: 'info', message: 'A' });
    useToastStore.getState().push({ id: 'b', variant: 'info', message: 'B' });
    useToastStore.getState().dismiss('a');
    const q = useToastStore.getState().queue;
    expect(q).toHaveLength(1);
    expect(q[0].id).toBe('b');
  });

  it('clear empties the queue', () => {
    useToastStore.getState().push({ id: 'a', variant: 'info', message: 'A' });
    useToastStore.getState().clear();
    expect(useToastStore.getState().queue).toEqual([]);
  });
});
