/**
 * User Store Hook
 */

import { useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { setAuthInfo, setUserInfo, setLanguage, setTheme, AuthenticatedInfoType, UserInfoType } from '@/store/modules/userCenter';
import type { RootState } from '@/store';

/**
 * useUserCenterStore
 */
export const useUserCenterStore = () => {
  const dispatch = useDispatch();

  const authInfo = useSelector((state: RootState) => state.userCenter.authInfo);
  const userInfo = useSelector((state: RootState) => state.userCenter.userInfo);
  const authRequired = useSelector((state: RootState) => state.userCenter.authRequired);
  const language = useSelector((state: RootState) => state.userCenter.language);
  const theme = useSelector((state: RootState) => state.userCenter.theme);

  /**
   * Update authentication information.
   *
   * @param authInfo - Authentication data object
   */
  const setAuthInfoAction = useCallback(
    (authInfo: AuthenticatedInfoType) => {
      dispatch(setAuthInfo(authInfo));
    },
    [dispatch],
  );

  /**
   * Update user profile information.
   *
   * @param userInfo - User profile data object
   */
  const setUserInfoAction = useCallback(
    (userInfo: UserInfoType) => {
      dispatch(setUserInfo(userInfo));
    },
    [dispatch],
  );

  /**
   * Update language.
   *
   * @param language - Language code
   */
  const setLanguageAction = useCallback(
    (language: string) => {
      dispatch(setLanguage(language));
    },
    [dispatch],
  );

  /**
   * Update theme.
   *
   * @param theme - Theme mode
   */
  const setThemeAction = useCallback(
    (theme: 'light' | 'dark' | 'system') => {
      dispatch(setTheme(theme));
    },
    [dispatch],
  );

  /**
   * Exposed API
   *
   * The returned object mimics a simple store interface,
   */
  return {
    authInfo,
    userInfo,
    authRequired,
    language,
    theme,
    setAuthInfo: setAuthInfoAction,
    setUserInfo: setUserInfoAction,
    setLanguage: setLanguageAction,
    setTheme: setThemeAction,
  };
};
