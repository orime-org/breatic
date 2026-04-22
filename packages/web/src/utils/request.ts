import axios, { AxiosRequestConfig } from 'axios';
import { getToken, removeToken } from './token';
import { logout as logoutApi } from '@/apis/auth';
import { googleLogout } from '@react-oauth/google';
import store from '@/store';
import { incrementLoading, decrementLoading } from '@/store/modules/loading';

interface CustomAxiosRequestConfig extends AxiosRequestConfig {
  needGlobalLoading?: boolean;
}

// No baseURL — call sites already include the full `/api/v1/...` path, so
// axios sends the request as-is. The browser resolves it against
// `location.origin`, which means the same bundle works on any host
// (localhost, staging, prod, preview deployments) as long as the frontend
// and API share one reverse proxy (nginx in docker, Vite dev proxy locally).
const request = axios.create({
  timeout: 180000,
});

request.interceptors.request.use(
  (config) => {
    const tokenStr = getToken();
    let token: string | null = null;
    const authInfo = JSON.parse(tokenStr as string);
    token = authInfo?.state?.token || null;
    if (token) {
      config.headers.authorization = `Bearer ${token}`;
    }
    const customConfig = config as CustomAxiosRequestConfig;
    if (customConfig.needGlobalLoading === true) {
      store.dispatch(incrementLoading());
    }
    return config;
  },
  (error) => Promise.reject(error),
);

request.interceptors.response.use(
  (response) => {
    const customConfig = response.config as CustomAxiosRequestConfig;
    if (customConfig.needGlobalLoading === true) {
      store.dispatch(decrementLoading());
    }
    return response.data;
  },
  async (error) => {
    const customConfig = error.config as CustomAxiosRequestConfig;
    const isNetworkError = !error.response && (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK' || error.message === 'Network Error');
    if (customConfig?.needGlobalLoading === true) {
      if (!isNetworkError) {
        store.dispatch(decrementLoading());
      }
    }
    if (error?.status === 401) {
      const authRequired = store.getState().userCenter.authRequired;
      // 跳过 logout 请求本身的 401，避免循环
      const isLogoutRequest = error.config?.url?.includes('/auth/logout');
      if (authRequired && !isLogoutRequest) {
        googleLogout();
        const tokenStr = getToken();
        const authInfo = tokenStr ? JSON.parse(tokenStr as string) : null;
        // 有 token 才调后端 logout（无 token 说明本来就没登录）
        if (authInfo?.state?.token) {
          await logoutApi().catch(() => {});
        }
        removeToken();
        window.location.href = '/workspace';
      }
    }
    return Promise.reject(error);
  },
);

export { request };
export type { CustomAxiosRequestConfig };
