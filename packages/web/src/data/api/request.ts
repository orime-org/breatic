// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  AxiosError,
} from 'axios';
import { getLocale } from '@breatic/shared';

import { ApiException, type ApiEnvelope, type ApiError } from '@web/data/api/types';
import { API_BASE_PATH } from '@web/data/api/base-path';

/**
 * Singleton axios instance configured for the breatic API.
 *
 * Auth: `withCredentials: true` makes the browser attach the
 * httpOnly session cookie on every cross-origin XHR. The
 * cookie is the single authentication channel since 2026-05-26 — no
 * Bearer token is read from JS, no Authorization header is set.
 * That removes the XSS exfiltration surface entirely (a JS payload
 * cannot read an httpOnly cookie).
 *
 * - `baseURL` is `API_BASE_PATH`, the one prefix this app and the streaming
 *   transport share, so production nginx routes everything under one origin;
 *   dev uses the Vite proxy.
 * - Request interceptor: send the language the user picked, so the server
 *   can answer in it.
 * - Response interceptor: unwrap backend error envelope into `ApiException`.
 * @returns A configured axios instance with the locale and error-normalizing interceptors attached.
 */
function createClient(): AxiosInstance {
  const instance = axios.create({
    // The one prefix, shared with the streaming transport. Per-resource paths
    // stay `/projects`, `/chat` etc. without `v1` smeared across them.
    baseURL: API_BASE_PATH,
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
  });

  // The server negotiates its reply language from `Accept-Language`, which
  // the browser fills from the OS setting. That is not the language the user
  // picked in our switcher — `changeLocale` writes localStorage and swaps the
  // UI catalog without touching the network. Sending it here is what joins
  // the two, and it is read per request because the user can switch at any
  // time while this singleton lives for the life of the page.
  instance.interceptors.request.use((config) => {
    // An explicit header from the caller wins; nothing sets one today, but
    // silently overwriting one would be a surprise if anything ever did.
    if (config.headers.get('Accept-Language') === undefined) {
      // The exact locale, not a prefix: the server prefix-matches `zh-*` to
      // the first supported `zh-` entry, so a `zh-TW` UI would otherwise be
      // answered in simplified Chinese.
      config.headers.set('Accept-Language', getLocale());
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

/**
 * Convert an arbitrary thrown value into a normalized `ApiError`.
 * Pulls status / code / message out of the backend error envelope when
 * the value is an `AxiosError`, and degrades gracefully otherwise.
 * @param err - The unknown value caught from a failed axios request.
 * @returns A normalized error with HTTP status, message, and optional code.
 */
function normalizeError(err: unknown): ApiError {
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 0;
    const data = err.response?.data as
      | { error?: { code?: string; message?: string } }
      | undefined;
    const written = data?.error?.message;
    return {
      status,
      message: written ?? err.message,
      code: data?.error?.code,
      fromServer: written !== undefined,
    };
  }
  if (err instanceof Error) {
    return { status: 0, message: err.message, fromServer: false };
  }
  return { status: 0, message: 'Unknown error', fromServer: false };
}

export const request = createClient();

/**
 * Typed GET helper — unwraps `{ data: T }` envelope, throws `ApiException`.
 * @param url - Resource path relative to the API base URL.
 * @param config - Optional axios request config (query params, headers, signal).
 * @returns The unwrapped response payload of type `T`.
 * @throws {ApiException} When the request fails or the server returns an error envelope.
 */
export async function apiGet<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.get<ApiEnvelope<T>>(url, config);
  return res.data.data;
}

/**
 * Typed POST helper — unwraps `{ data: T }` envelope.
 * @param url - Resource path relative to the API base URL.
 * @param body - Optional request body serialized as JSON.
 * @param config - Optional axios request config (headers, signal).
 * @returns The unwrapped response payload of type `T`.
 * @throws {ApiException} When the request fails or the server returns an error envelope.
 */
export async function apiPost<T, B = unknown>(
  url: string,
  body?: B,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.post<ApiEnvelope<T>>(url, body, config);
  return res.data.data;
}

/**
 * Typed PATCH helper — unwraps `{ data: T }` envelope.
 * @param url - Resource path relative to the API base URL.
 * @param body - Optional partial-update request body serialized as JSON.
 * @param config - Optional axios request config (headers, signal).
 * @returns The unwrapped response payload of type `T`.
 * @throws {ApiException} When the request fails or the server returns an error envelope.
 */
export async function apiPatch<T, B = unknown>(
  url: string,
  body?: B,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.patch<ApiEnvelope<T>>(url, body, config);
  return res.data.data;
}

/**
 * Typed DELETE helper — unwraps `{ data: T }` envelope.
 * @param url - Resource path relative to the API base URL.
 * @param config - Optional axios request config (headers, signal).
 * @returns The unwrapped response payload of type `T` (defaults to `void`).
 * @throws {ApiException} When the request fails or the server returns an error envelope.
 */
export async function apiDelete<T = void>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await request.delete<ApiEnvelope<T>>(url, config);
  return res.data.data;
}
