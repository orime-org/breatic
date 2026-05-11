/**
 * CurrentUserContext — exposes the authenticated user's id + username
 * to deep subtrees (canvas hooks, composers, etc.) without prop drilling.
 *
 * The page-level `ProjectContentBody` fetches the user via
 * `authApi.getMe()` once on mount and provides it through this context.
 * Hooks like `useCanvasActions` consume it when stamping `createdBy`
 * onto new Yjs nodes (spec §5.3.2.1 v13) and when constructing
 * `HandlingActor` for frontend-driven mini-tool work (ADR
 * `2026-05-11-mini-tool-state-machine.md`).
 *
 * Returns `null` for either field when the user is not yet resolved
 * (mount race) or when no provider is mounted (defensive default for
 * unit tests). Callers must guard with `if (!userId) return;` before
 * writes that depend on it.
 */
import { createContext, useContext, type ReactNode } from 'react';

interface CurrentUser {
  id: string | null;
  username: string | null;
}

const CurrentUserContext = createContext<CurrentUser>({ id: null, username: null });

interface CurrentUserProviderProps {
  /** Resolved user id, or `null` during the mount-time `getMe()` race. */
  id: string | null;
  /** Resolved username (may be `null` server-side too — UserEntity allows it). */
  username: string | null;
  children: ReactNode;
}

/** Provider mounted by the project page once `currentUser` is fetched. */
export function CurrentUserProvider({ id, username, children }: CurrentUserProviderProps): ReactNode {
  return (
    <CurrentUserContext.Provider value={{ id, username }}>{children}</CurrentUserContext.Provider>
  );
}

/** Read the authenticated user's id, or `null` if not yet resolved. */
export function useCurrentUserId(): string | null {
  return useContext(CurrentUserContext).id;
}

/** Read the authenticated user's username, or `null` if not yet resolved / unset. */
export function useCurrentUsername(): string | null {
  return useContext(CurrentUserContext).username;
}
