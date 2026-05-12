/**
 * `userCenterStore` — Zustand replacement for the old Redux
 * `userCenter` slice. Owns the four pieces of cross-cutting user
 * state every layer touches:
 *
 *   - `authInfo`    — session token + boot-time hydration from localStorage
 *   - `userInfo`    — profile + credits (refreshed by features/credits)
 *   - `theme`       — light / dark / system
 *   - `language`    — i18n code
 *
 * `authRequired` is derived once from the env at module load (matches
 * the Redux version's behaviour) and lives on the store as a read-only
 * flag so consumers don't import `import.meta.env` directly.
 *
 * Setter contract preserved verbatim from the Redux slice — each one
 * mirrors the side effect (localStorage write) and the public signature
 * so the `useUserCenterStore` hook can swap implementations without
 * touching call sites.
 */
import { create } from 'zustand';

const authRequired = import.meta.env.VITE_LOGIN_MODE === 'WithAccount';

export interface UserInfoType {
  name: string;
  avatar: string;
  free_credits: number;
  purchase_credits: number;
  total_credits: number;
  email?: string;
}

export interface AuthenticatedInfoType {
  state: {
    isAuthenticated: boolean;
    token: string;
  };
}

interface UserCenterState {
  authInfo: AuthenticatedInfoType;
  authRequired: boolean;
  userInfo: UserInfoType;
  theme: 'light' | 'dark' | 'system';
  language: string;
  setAuthInfo: (authInfo: AuthenticatedInfoType) => void;
  setUserInfo: (userInfo: UserInfoType) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setLanguage: (language: string) => void;
}

/**
 * Boot-time auth hydration — runs at module import, before any
 * component renders. Matches the Redux slice's behaviour exactly so
 * the persisted session survives the swap.
 */
function loadInitialAuthInfo(): AuthenticatedInfoType {
  if (!authRequired) {
    return {
      state: {
        isAuthenticated: true,
        token: 'ThisIsATemporaryToken',
      },
    };
  }
  try {
    const raw = localStorage.getItem('auth');
    if (raw) {
      const parsed = JSON.parse(raw) as AuthenticatedInfoType;
      if (parsed?.state?.token) return parsed;
    }
  } catch {
    // Malformed localStorage — fall through to unauthenticated default.
  }
  return {
    state: {
      isAuthenticated: false,
      token: '',
    },
  };
}

/**
 * Restore a previously chosen theme from localStorage, falling back to
 * `'system'` so the OS preference drives the first paint when nothing
 * has been chosen yet. Matches mock 05 DEFAULTS (line 520, `th:
 * 'system'` per the 2026-05-12 token alignment).
 */
function loadInitialTheme(): 'light' | 'dark' | 'system' {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
  } catch {
    // localStorage may be disabled (private browsing / SSR / etc.).
  }
  return 'system';
}

function loadInitialLanguage(): string {
  try {
    const saved = localStorage.getItem('language');
    if (saved) return saved;
  } catch {
    // see loadInitialTheme.
  }
  return 'en';
}

export const useUserCenter = create<UserCenterState>((set) => ({
  authInfo: loadInitialAuthInfo(),
  authRequired,
  userInfo: {} as UserInfoType,
  theme: loadInitialTheme(),
  language: loadInitialLanguage(),
  setAuthInfo: (authInfo) => {
    set({ authInfo });
    localStorage.setItem('auth', JSON.stringify(authInfo));
  },
  setUserInfo: (userInfo) => set({ userInfo }),
  setTheme: (theme) => {
    set({ theme });
    localStorage.setItem('theme', theme);
  },
  setLanguage: (language) => {
    set({ language });
    localStorage.setItem('language', language);
  },
}));
