import { useSelector } from 'react-redux';
import type { RootState } from '@/store';

/**
 * Returns whether any in-flight request toggled the global loading overlay.
 *
 * @example
 * ```tsx
 * const loading = useLoading();
 * return loading ? <Loading /> : <Content />;
 * ```
 */
export const useLoading = (): boolean => {
  const loadingCount = useSelector((state: RootState) => state.loading.count);
  return loadingCount > 0;
};

/** Raw count of nested loading tokens (useful for debugging concurrent requests). */
export const useLoadingCount = (): number => {
  return useSelector((state: RootState) => state.loading.count);
};
