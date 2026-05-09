/**
 * CurrentUserContext — exposes the authenticated user's id to deep
 * subtrees (canvas hooks, composers, etc.) without prop drilling.
 *
 * The page-level `ProjectContentBody` fetches `currentUserId` via
 * `authApi.getMe()` once on mount and provides it through this context.
 * Hooks like `useCanvasActions` consume it when stamping `createdBy`
 * onto new Yjs nodes (spec §5.3.2.1 v13).
 *
 * Returns `null` when the user is not yet resolved (mount race) or
 * when no provider is mounted (defensive default for unit tests).
 * Callers must guard with `if (!userId) return;` before writes that
 * depend on it.
 */
import { createContext, useContext, type ReactNode } from 'react';

const CurrentUserIdContext = createContext<string | null>(null);

interface CurrentUserIdProviderProps {
  /** Resolved user id, or `null` during the mount-time `getMe()` race. */
  value: string | null;
  children: ReactNode;
}

/** Provider mounted by the project page once `currentUserId` is fetched. */
export function CurrentUserIdProvider({ value, children }: CurrentUserIdProviderProps): ReactNode {
  return <CurrentUserIdContext.Provider value={value}>{children}</CurrentUserIdContext.Provider>;
}

/** Read the authenticated user's id, or `null` if not yet resolved. */
export function useCurrentUserId(): string | null {
  return useContext(CurrentUserIdContext);
}
