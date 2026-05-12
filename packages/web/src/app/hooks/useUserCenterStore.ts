/**
 * `useUserCenterStore` — public hook for the user-center store.
 *
 * Public shape preserved from the Redux era so call sites don't
 * change. Internally it now reads from the Zustand store. Each setter
 * is a stable reference (Zustand returns the same function instance
 * across renders), so the previous `useCallback` wrapping is gone.
 */
import { useUserCenter, type AuthenticatedInfoType, type UserInfoType } from '@/app/store/userCenterStore';

export type { AuthenticatedInfoType, UserInfoType };

export const useUserCenterStore = () => {
  // Slice subscriptions — each component only re-renders when the
  // exact field it reads changes, which matches the per-field
  // `useSelector` pattern the Redux version used.
  const authInfo = useUserCenter((s) => s.authInfo);
  const userInfo = useUserCenter((s) => s.userInfo);
  const authRequired = useUserCenter((s) => s.authRequired);
  const language = useUserCenter((s) => s.language);
  const theme = useUserCenter((s) => s.theme);
  const setAuthInfo = useUserCenter((s) => s.setAuthInfo);
  const setUserInfo = useUserCenter((s) => s.setUserInfo);
  const setLanguage = useUserCenter((s) => s.setLanguage);
  const setTheme = useUserCenter((s) => s.setTheme);

  return {
    authInfo,
    userInfo,
    authRequired,
    language,
    theme,
    setAuthInfo,
    setUserInfo,
    setLanguage,
    setTheme,
  };
};
