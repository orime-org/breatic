import { createSlice, PayloadAction } from '@reduxjs/toolkit';

/**
 * 认证模式：WithAccount 需要认证，NoAccount 不需要
 */
const authRequired = import.meta.env.VITE_LOGIN_MODE === 'WithAccount';

export interface UserInfoType {
  name: string;
  avatar: string;
  // Breatic is credits-only — no subscription tiers. Keep the three credit
  // buckets for display (free grant + purchased + computed total) but no
  // plan/tier/membership fields.
  free_credits: number;
  purchase_credits: number;
  total_credits: number;
  email?: string;
}

/**
 * 认证信息，持久化到 localStorage
 */
export interface AuthenticatedInfoType {
  state: {
    isAuthenticated: boolean;
    token: string;
  };
}

export interface UserCenterState {
  authInfo: AuthenticatedInfoType;
  authRequired: boolean;
  userInfo: UserInfoType;
  theme: 'light' | 'dark' | 'system';
  language: string;
}

/**
 * Boot-time auth hydration — runs at module import, before any component
 * renders. This guarantees deep links like `/project/<id>` see the
 * persisted session on the very first render, instead of relying on a
 * `useEffect` in a sibling route component.
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

const initialState: UserCenterState = {
  authInfo: loadInitialAuthInfo(),
  authRequired: authRequired,
  userInfo: {} as UserInfoType,
  theme: 'light',
  language: 'en',
};

const userCenterStore = createSlice({
  name: 'userCenter',
  initialState,
  reducers: {
    setAuthInfo: (state, action: PayloadAction<AuthenticatedInfoType>) => {
      state.authInfo = action.payload;
      localStorage.setItem('auth', JSON.stringify(action.payload));
    },
    setUserInfo: (state, action: PayloadAction<UserInfoType>) => {
      state.userInfo = action.payload;
    },
    setTheme: (state, action: PayloadAction<'light' | 'dark' | 'system'>) => {
      state.theme = action.payload;
      localStorage.setItem('theme', action.payload);
    },
    setLanguage: (state, action: PayloadAction<string>) => {
      state.language = action.payload;
      localStorage.setItem('language', action.payload);
    }
  }
});

export const {
  setAuthInfo, setUserInfo, setTheme, setLanguage
} = userCenterStore.actions;

export default userCenterStore.reducer;
