/**
 * Public hooks for the loading store.
 *
 * The shape is unchanged from the Redux era — components read whether
 * anything is loading, or the raw count for debugging. Internally
 * backed by Zustand.
 */
import { useLoadingStore } from '@/app/store/loadingStore';

/**
 * Returns whether any in-flight request toggled the global loading overlay.
 *
 * @example
 * ```tsx
 * const loading = useLoading();
 * return loading ? <Loading /> : <Content />;
 * ```
 */
export const useLoading = (): boolean => useLoadingStore((s) => s.count > 0);

/** Raw count of nested loading tokens (useful for debugging concurrent requests). */
export const useLoadingCount = (): number => useLoadingStore((s) => s.count);
