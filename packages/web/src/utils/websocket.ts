/**
 * Lightweight WebSocket helper with heartbeat, reconnect, and optional message callback.
 */

import { message } from '@/components/base/message';

let socketUrl: string = '';
let socketQueryParams: Record<string, string | number | undefined> | undefined = undefined;
let websocket: WebSocket | null = null;
let heartTime: ReturnType<typeof setInterval> | null = null;
let socketHeart = 0 as number;
const heartTimeOut = 10000;
const maxReconnectCount = 3;
let socketError = 0 as number;

let messageCallback: ((data: string | object) => void) | null = null;

/**
 * Opens a WebSocket on the current page's origin (same-origin as the SPA).
 * @param path - Path segment, e.g. `/api/ws/workflow`
 * @param queryParams - Serialized onto the query string
 *
 * WebSocket URLs cannot be relative strings — the constructor requires a
 * fully-qualified `ws://` or `wss://` URL. We build it at runtime from
 * `window.location`, so the connection automatically targets whatever host
 * the user is browsing (dev localhost, staging, prod, or preview).
 */
export const initWebSocket = (
  path: string,
  queryParams?: Record<string, string | number | undefined>
): WebSocket | null => {
  const websocketEnabled = import.meta.env.VITE_APP_WEBSOCKET;
  if (websocketEnabled === 'false') {
    return null;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${window.location.host}${path}`;
  socketUrl = path;
  socketQueryParams = queryParams;

  let wsUrl: string;
  if (queryParams) {
    const params = new URLSearchParams();

    Object.entries(queryParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    });

    const separator = url.includes('?') ? '&' : '?';
    wsUrl = `${url}${separator}${params.toString()}`;
  } else {
    wsUrl = url;
  }

  try {
    // eslint-disable-next-line no-console
    console.log('Creating WebSocket:', wsUrl);
    websocket = new WebSocket(wsUrl);
    websocketonopen();
    websocketonmessage();
    websocketonerror();
    websocketclose();
    sendSocketHeart();
    // eslint-disable-next-line no-console
    console.log('WebSocket instance ready');
    return websocket;
  } catch (error) {
    console.error('Failed to init WebSocket:', error);
    return null;
  }
};

export const websocketonopen = (): void => {
  if (!websocket) return;
  websocket.onopen = () => {
    // eslint-disable-next-line no-console
    console.log('WebSocket connected');
    resetHeart();
  };
};

export const websocketonerror = (): void => {
  if (!websocket) return;

  websocket.onerror = (e: Event) => {
    console.error('WebSocket error', e);
  };
};

export const websocketclose = (): void => {
  if (!websocket) return;
  websocket.onclose = (e: CloseEvent) => {
    // eslint-disable-next-line no-console
    console.log('WebSocket closed', e);
    if (e.code !== 1000) {
      reconnect();
    }
  };
};

export const resetHeart = (): void => {
  socketHeart = 0;
  socketError = 0;
  if (heartTime) {
    clearInterval(heartTime);
    heartTime = null;
  }
  sendSocketHeart();
};

export const sendSocketHeart = (): void => {
  if (heartTime) {
    clearInterval(heartTime);
  }

  heartTime = setInterval(() => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(
        JSON.stringify({
          code: 20001,
          data: 'Are you OK?',
          msg: ''
        })
      );
      socketHeart = socketHeart + 1;
    } else {
      console.warn('WebSocket not open', WebSocket);
      reconnect();
    }
  }, heartTimeOut);
};

export const reconnect = (): void => {
  if (socketError < maxReconnectCount) {
    if (heartTime) {
      clearInterval(heartTime);
      heartTime = null;
    }
    socketError = socketError + 1;
    // eslint-disable-next-line no-console
    console.log(`WebSocket reconnect attempt ${socketError}`);
    initWebSocket(socketUrl, socketQueryParams);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Reconnect limit reached (${maxReconnectCount})`);
    if (heartTime) {
      clearInterval(heartTime);
      heartTime = null;
    }
    message.error(
      `WebSocket failed after ${maxReconnectCount} retries. Refresh the page to try again.`
    );
  }
};

/** Sends a string or JSON-serialized object when the socket is open. */
export const sendMsg = (data: string | object): void => {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not connected; message not sent');
    return;
  }

  const messageData = typeof data === 'string' ? data : JSON.stringify(data);
  websocket.send(messageData);
};

/**
 * Attaches the onmessage handler; optional callback receives parsed payloads.
 * @param callback - Invoked for each non-heartbeat frame
 */
export const websocketonmessage = (callback?: (data: string | object) => void): void => {
  if (!websocket) return;

  if (callback) {
    messageCallback = callback;
  }

  websocket.onmessage = (e: MessageEvent) => {
    const data = e.data;
    if (typeof data === 'string' && data.indexOf('10001') > -1) {
      resetHeart();
      return;
    }
    if (typeof data === 'string' && data.indexOf('20002') > -1) {
      return;
    }

    let parsedData: string | object = data;
    if (typeof data === 'string') {
      try {
        parsedData = JSON.parse(data);
      } catch {
        /* keep raw string */
      }
    }

    if (messageCallback) {
      messageCallback(parsedData);
    }

    return e.data;
  };
};

/** Closes the socket, clears timers, and resets internal state. */
export const closeWebSocketConnection = (): void => {
  if (heartTime) {
    clearInterval(heartTime);
    heartTime = null;
  }

  if (websocket) {
    websocket.onclose = null;
    websocket.onerror = null;
    websocket.close(1000, 'client closed');
    websocket = null;
  }

  socketHeart = 0;
  socketError = 0;
  socketUrl = '';
  socketQueryParams = undefined;
};

