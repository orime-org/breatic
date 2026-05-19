import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  AxiosError,
} from 'axios';

import { useCurrentUserStore } from '@/stores';
import { ApiException, type ApiError } from './types';

/**
 * Singleton axios instance configured for the breatic API.
 *
 * - `baseURL` defaults to `/api` so production nginx routes everything
 *   under one origin; dev uses Vite proxy.
 * - Request interceptor: attach `Bearer <token>` from current-user store.
 * - Response interceptor: unwrap backend error envelope into `ApiException`.
 */
function createClient(): AxiosInstance {
  const instance = axios.create({
    baseURL: '/api',
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  instance.interceptors.request.use((config) => {
    const token = useCurrentUserStore.getState().token;
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  instance.interceptors.response.use(
    (res) => res,
    (err: unknown) => {
      const apiErr = normalizeError(err);
      return Promise.reject(new ApiException(apiErr));
    },
  );

  return instance;
}

function normalizeError(err: unknown): ApiError {
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 0;
    const data = err.response?.data as
      | { error?: { code?: string; message?: string } }
      | undefined;
    return {
      status,
      message: data?.error?.message ?? err.message,
      code: data?.error?.code,
    };
  }
  if (err instanceof Error) {
    return { status: 0, message: err.message };
  }
  return { status: 0, message: 'Unknown error' };
}

export const request = createClient();

/** Typed GET helper (returns `data` payload, throws `ApiException`). */
export async function apiGet<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.get<T>(url, config);
  return res.data;
}

/** Typed POST helper. */
export async function apiPost<T, B = unknown>(
  url: string,
  body?: B,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.post<T>(url, body, config);
  return res.data;
}

/** Typed PATCH helper. */
export async function apiPatch<T, B = unknown>(
  url: string,
  body?: B,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.patch<T>(url, body, config);
  return res.data;
}

/** Typed DELETE helper. */
export async function apiDelete<T = void>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.delete<T>(url, config);
  return res.data;
}
