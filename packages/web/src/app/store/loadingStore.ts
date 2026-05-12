/**
 * `loadingStore` — Zustand replacement for the old Redux `loading`
 * slice. Tracks a count of in-flight requests (nestable) so the global
 * loading overlay can show whenever `count > 0`.
 *
 * The increment / decrement pair guards against negatives — a stray
 * `decrement` (e.g. a request rejected before increment) clamps to 0
 * rather than going negative, matching the Redux slice's behaviour.
 *
 * Imperative setters are exposed at module level (`loadingActions`) so
 * non-component callers like the axios request interceptor can dispatch
 * without going through a hook. React consumers use the `useLoading`
 * hook in `app/hooks/useLoading.ts`.
 */
import { create } from 'zustand';

interface LoadingState {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
  setCount: (n: number) => void;
}

export const useLoadingStore = create<LoadingState>((set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
  decrement: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
  reset: () => set({ count: 0 }),
  setCount: (n) => set({ count: Math.max(0, n) }),
}));

/**
 * Imperative handle for non-React callers (axios interceptors, tests).
 * Reads the latest setter from the store on each call so the function
 * identity is stable.
 */
export const loadingActions = {
  increment: () => useLoadingStore.getState().increment(),
  decrement: () => useLoadingStore.getState().decrement(),
  reset: () => useLoadingStore.getState().reset(),
  setCount: (n: number) => useLoadingStore.getState().setCount(n),
};
