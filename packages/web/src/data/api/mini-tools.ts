/**
 * Mini-tools API — image/video/audio/text tool execution.
 */

import { request } from '@/data/api/request';
import { sse } from '@/data/stream/sse';
import type { TaskEntity, ApiResponse } from '@breatic/shared';

/** Execute an image mini-tool (async via Worker). */
export const executeImage = (data: Record<string, unknown>) =>
  request<ApiResponse<TaskEntity>>({
    url: '/api/v1/mini-tools/image',
    method: 'post',
    data,
  });

/** Execute a video mini-tool (async via Worker). */
export const executeVideo = (data: Record<string, unknown>) =>
  request<ApiResponse<TaskEntity>>({
    url: '/api/v1/mini-tools/video',
    method: 'post',
    data,
  });

/** Execute an audio mini-tool (async via Worker). */
export const executeAudio = (data: Record<string, unknown>) =>
  request<ApiResponse<TaskEntity>>({
    url: '/api/v1/mini-tools/audio',
    method: 'post',
    data,
  });

/** Execute a text mini-tool (sync SSE stream). */
export const executeText = (
  body: Record<string, unknown>,
  config: {
    onmessage?: (ev: { event: string; data: string }) => void;
    onerror?: (err: Error) => void;
    onopen?: (response: Response) => Promise<void>;
    onclose?: () => void;
    signal?: AbortSignal;
  },
) =>
  sse({
    url: '/api/v1/mini-tools/text',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: config.signal,
    onopen: config.onopen,
    onmessage: config.onmessage,
    onerror: config.onerror,
    onclose: config.onclose,
  });
