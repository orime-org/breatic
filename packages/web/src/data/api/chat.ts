/**
 * Chat API — Agent conversation via SSE.
 */

import { sse } from '@/data/stream/sse';
import { request } from '@/data/api/request';
import type { ConversationEntity, ApiResponse, PaginatedResponse, ChatMessageInput, SkillCommandInput } from '@breatic/shared';

/** Send a chat message and receive SSE stream. */
export const sendMessage = (
  body: ChatMessageInput,
  config: {
    onmessage?: (ev: { event: string; data: string }) => void;
    onerror?: (err: Error) => void;
    onopen?: (response: Response) => Promise<void>;
    onclose?: () => void;
    signal?: AbortSignal;
  },
) =>
  sse({
    url: '/api/v1/chat/message',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: config.signal,
    onopen: config.onopen,
    onmessage: config.onmessage,
    onerror: config.onerror,
    onclose: config.onclose,
  });

/** Execute a skill command via SSE stream. */
export const sendSkillCommand = (
  body: SkillCommandInput,
  config: {
    onmessage?: (ev: { event: string; data: string }) => void;
    onerror?: (err: Error) => void;
    onopen?: (response: Response) => Promise<void>;
    onclose?: () => void;
    signal?: AbortSignal;
  },
) =>
  sse({
    url: '/api/v1/chat/skill',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: config.signal,
    onopen: config.onopen,
    onmessage: config.onmessage,
    onerror: config.onerror,
    onclose: config.onclose,
  });

/** List conversations for the current user. */
export const listConversations = (params: { limit?: number; offset?: number } = {}) =>
  request<PaginatedResponse<ConversationEntity>>({
    url: '/api/v1/chat/conversations',
    method: 'get',
    params,
  });

/** Get a conversation with its messages. */
export const getConversation = (id: string) =>
  request<ApiResponse<{ conversation: ConversationEntity; messages: unknown[] }>>({
    url: `/api/v1/chat/conversations/${id}`,
    method: 'get',
  });

/** Delete a conversation. */
export const deleteConversation = (id: string) =>
  request({
    url: `/api/v1/chat/conversations/${id}`,
    method: 'delete',
  });
