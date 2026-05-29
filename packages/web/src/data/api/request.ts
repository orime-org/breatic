import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  AxiosError,
} from 'axios';

import { ApiException, type ApiEnvelope, type ApiError } from '@web/data/api/types';

/**
 * Singleton axios instance configured for the breatic API.
 *
 * Auth: `withCredentials: true` makes the browser attach the
 * httpOnly `breatic_session` cookie on every cross-origin XHR. The
 * cookie is the single authentication channel since 2026-05-26 — no
 * Bearer token is read from JS, no Authorization header is set.
 * That removes the XSS exfiltration surface entirely (a JS payload
 * cannot read an httpOnly cookie).
 *
 * - `baseURL` defaults to `/api` so production nginx routes everything
 *   under one origin; dev uses Vite proxy.
 * - Response interceptor: unwrap backend error envelope into `ApiException`.
 */
function createClient(): AxiosInstance {
  const instance = axios.create({
    // Server mounts every route under `/api/v1/*` (see packages/server/src/app.ts).
    // Vite proxy `/api/*` → :3000/api/* in dev; nginx in prod. Client
    // therefore points at `/api/v1` so per-resource paths stay `/projects`,
    // `/chat` etc. without `v1` smeared everywhere.
    baseURL: '/api/v1',
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
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

/** Typed GET helper — unwraps `{ data: T }` envelope, throws `ApiException`. */
export async function apiGet<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.get<ApiEnvelope<T>>(url, config);
  return res.data.data;
}

/** Typed POST helper — unwraps `{ data: T }` envelope. */
export async function apiPost<T, B = unknown>(
  url: string,
  body?: B,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.post<ApiEnvelope<T>>(url, body, config);
  return res.data.data;
}

/** Typed PATCH helper — unwraps `{ data: T }` envelope. */
export async function apiPatch<T, B = unknown>(
  url: string,
  body?: B,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.patch<ApiEnvelope<T>>(url, body, config);
  return res.data.data;
}

/** Typed DELETE helper — unwraps `{ data: T }` envelope. */
export async function apiDelete<T = void>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.delete<ApiEnvelope<T>>(url, config);
  return res.data.data;
}
