import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getToken, removeToken } from './token';
import router from '@/router';

export interface SSEConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  params?: Record<string, string | number | undefined>;
  onmessage?: (ev: { event: string; data: string }) => void;
  onerror?: (err: Error) => void;
  onopen?: (response: Response) => Promise<void>;
  onclose?: () => void;
  signal?: AbortSignal;
}

/**
 * Server-Sent Events helper wrapping `fetchEventSource`.
 * @example
 * const controller = new AbortController();
 * sse({
 *   url: '/api/workflow/node/sse',
 *   method: 'POST',
 *   body: { workflow_id: '123' },
 *   signal: controller.signal,
 *   onmessage: (ev) => console.log(ev.event, ev.data),
 * });
 */
export const sse = async (config: SSEConfig) => {
  const tokenStr = getToken();
  let token: string | null = null;
  const authInfo = JSON.parse(tokenStr as string);
  token = authInfo?.state?.token || null;

  const language = 'en';

  const mergedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    'Accept-Language': language,
    ...config.headers,
  };
  if (token) {
    mergedHeaders.Authorization = `Bearer ${token}`;
  }

  let finalUrl = config.url;
  if (config.params) {
    const params = new URLSearchParams();
    Object.entries(config.params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    });
    const queryString = params.toString();
    if (queryString) {
      finalUrl += (config.url.includes('?') ? '&' : '?') + queryString;
    }
  }

  // finalUrl is already relative (e.g. `/api/v1/...`). fetchEventSource
  // resolves it against window.location the same way fetch() does.
  return fetchEventSource(finalUrl, {
    method: config.method || 'GET',
    headers: mergedHeaders,
    body: config.body ? JSON.stringify(config.body) : undefined,
    signal: config.signal,
    openWhenHidden: true,
    onopen: async (response) => {
      if (response.ok) {
        await config.onopen?.(response);
        return;
      }
      if (response.status === 401) {
        removeToken();
        await router.navigate('/login');
      }
      throw new Error(`Failed to open stream: ${response.status} ${response.statusText}`);
    },
    onmessage: (event) => {
      if (event.event === 'ping') {
        return;
      }
      if (event.data) {
        config.onmessage?.(event);
      }
    },
    onerror: (err) => {
      throw err;
    },
    onclose: () => {
      config.onclose?.();
    },
  });
};
