// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageData, SSEEventEnvelope } from '@breatic/shared';
import { SSE_EVENT_NAMES } from '@breatic/shared';

import { chatApi } from '@web/data/api/chat';
import type { OpenChatResult } from '@web/data/api/chat';
import { useChatStore } from '@web/stores';
import type { ChatMessage, ToolCall } from '@web/pages/project/chat/types';

/**
 * A message as the cache holds it.
 *
 * A stored message plus the one state that is local by nature: a turn that
 * failed leaves a reply on screen, and nothing about that is written down.
 */
type CachedMessage = MessageData & { failed?: boolean };

/** The open-chat answer with the cache's own message shape. */
type CachedChat = Omit<OpenChatResult, 'current'> & {
  current: Omit<OpenChatResult['current'], 'messages'> & { messages: CachedMessage[] };
};

/**
 * Query key for one project's chat.
 * @param projectId - The project whose chat this identifies
 * @returns The cache key both the fetch and every write to it use
 */
const chatKey = (projectId: string): readonly unknown[] => ['chat-open', projectId];

export interface ChatSession {
  /** Every message to show, history and the reply in flight alike. */
  messages: ChatMessage[];
  /** True until the server has answered — not the same as an empty chat. */
  isPending: boolean;
  /** Send one message and stream the reply into the list. */
  send: (text: string) => Promise<void>;
  /** Stop the turn in flight. */
  abort: () => void;
}

/**
 * Adapt one stored message into what the panel renders.
 * @param message - The message as the server hands it out
 * @returns The same message in the panel's shape
 */
function toChatMessage(message: CachedMessage): ChatMessage {
  const toolCalls: ToolCall[] = message.parts
    .filter((p) => p.type === 'tool')
    .map((p) => {
      const part = p as Extract<MessageData['parts'][number], { type: 'tool' }>;
      return {
        id: part.toolCallId,
        name: part.toolName,
        args: part.input,
        status: part.status,
        ...(part.output !== undefined ? { result: part.output } : {}),
        ...(part.errorMessage !== undefined ? { errorMessage: part.errorMessage } : {}),
      };
    });

  return {
    id: message.id ?? '',
    // A stored role is only ever one of these two; the panel's third is for
    // messages it makes up itself, which none of these are.
    role: message.role,
    content: message.content,
    ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(message.interrupted ? { interrupted: true as const } : {}),
    ...(message.failed ? { failed: true } : {}),
  };
}

/**
 * The chat panel's messages, and the two things it can do with them.
 *
 * History and the reply being streamed live in the same cache entry, and the
 * panel reads only that. Keeping them apart is what makes a reply show twice,
 * vanish as the stream ends, or come back reordered after a refresh.
 *
 * A turn in flight is tied to the mounted panel: collapsing the column
 * unmounts it, and the turn stops with it rather than streaming into a list
 * nobody is holding. What the model wrote by then is still stored, with a
 * mark saying it was cut off.
 * @param projectId - Project whose chat this is
 * @returns The messages, whether they have arrived, and send / stop
 */
export function useChatSession(projectId: string): ChatSession {
  const queryClient = useQueryClient();
  const setStreaming = useChatStore((s) => s.setStreaming);
  const setActiveConversationId = useChatStore((s) => s.setActiveConversationId);
  const inFlight = React.useRef<AbortController | null>(null);

  const query = useQuery<CachedChat>({
    queryKey: chatKey(projectId),
    queryFn: () => chatApi.openChat(projectId),
  });

  const conversationId = query.data?.current.conversation.id;

  React.useEffect(() => {
    if (conversationId) setActiveConversationId(conversationId);
  }, [conversationId, setActiveConversationId]);

  // The turn belongs to this mounted panel. Unmounting stops it; without
  // this, pieces of a reply keep arriving for a list that is gone, and the
  // next mount refetches history the reply is not in yet.
  React.useEffect(() => {
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, []);

  /**
   * Rewrite one message in the cache.
   * @param id - The message to rewrite
   * @param change - Applied to it, returning the replacement
   */
  const patchMessage = React.useCallback(
    (id: string, change: (m: CachedMessage) => CachedMessage): void => {
      queryClient.setQueryData<CachedChat>(chatKey(projectId), (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          current: {
            ...prev.current,
            messages: prev.current.messages.map((m) => (m.id === id ? change(m) : m)),
          },
        };
      });
    },
    [queryClient, projectId],
  );

  /**
   * Add messages to the end of the list.
   * @param added - The messages to append
   */
  const appendMessages = React.useCallback(
    (added: CachedMessage[]): void => {
      queryClient.setQueryData<CachedChat>(chatKey(projectId), (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          current: { ...prev.current, messages: [...prev.current.messages, ...added] },
        };
      });
    },
    [queryClient, projectId],
  );

  /** End the turn in flight, however it ended. */
  const finishTurn = React.useCallback((): void => {
    inFlight.current = null;
    setStreaming(false);
  }, [setStreaming]);

  const abort = React.useCallback((): void => {
    inFlight.current?.abort();
    finishTurn();
  }, [finishTurn]);

  const send = React.useCallback(
    async (text: string): Promise<void> => {
      if (!conversationId) return;

      const now = new Date().toISOString();
      const replyId = `local-reply-${crypto.randomUUID()}`;
      const turnIndex = (query.data?.current.messages.at(-1)?.turnIndex ?? 0) + 1;

      appendMessages([
        {
          id: `local-user-${crypto.randomUUID()}`,
          role: 'user',
          parts: [{ type: 'text', text }],
          content: text,
          ts: now,
          turnIndex,
        },
        { id: replyId, role: 'assistant', parts: [], content: '', ts: now, turnIndex },
      ]);

      const controller = new AbortController();
      inFlight.current = controller;
      setStreaming(true);

      await chatApi.streamMessage(
        { projectId, conversationId, message: text },
        {
          signal: controller.signal,
          onEvent: (event: SSEEventEnvelope) => {
            switch (event.event) {
              case SSE_EVENT_NAMES.CHAT_CHUNK:
                patchMessage(replyId, (m) => ({
                  ...m,
                  content: m.content + String(event.data.text ?? ''),
                }));
                break;

              case SSE_EVENT_NAMES.AGENT_THINKING:
                patchMessage(replyId, (m) => ({
                  ...m,
                  thinking: (m.thinking ?? '') + String(event.data.text ?? ''),
                }));
                break;

              case SSE_EVENT_NAMES.CHAT_DONE:
                if (event.data.aborted) {
                  patchMessage(replyId, (m) => ({ ...m, interrupted: true as const }));
                }
                finishTurn();
                break;

              case SSE_EVENT_NAMES.ERROR:
                // What the server says here is a hardcoded English sentence;
                // the panel shows its own wording, so only the fact matters.
                patchMessage(replyId, (m) => ({ ...m, failed: true }));
                finishTurn();
                break;

              // Raised as the model reaches for a tool, and as it hands back
              // something for the panel to draw. Rendering those is PR-6;
              // they are named here so a new event is a missing case rather
              // than something this silently ignored all along.
              case SSE_EVENT_NAMES.AGENT_TOOL_HINT:
              case SSE_EVENT_NAMES.AGENT_ASK:
              case SSE_EVENT_NAMES.AGENT_CHOICE:
              case SSE_EVENT_NAMES.AGENT_CANVAS_ACTION:
              case SSE_EVENT_NAMES.AGENT_SEARCH_RESULTS:
                break;
            }
          },
          onClose: finishTurn,
          onError: () => {
            patchMessage(replyId, (m) => ({ ...m, failed: true }));
            finishTurn();
          },
        },
      );
    },
    [
      projectId,
      conversationId,
      query.data,
      appendMessages,
      patchMessage,
      setStreaming,
      finishTurn,
    ],
  );

  const messages = React.useMemo(
    () => (query.data?.current.messages ?? []).map(toChatMessage),
    [query.data],
  );

  return { messages, isPending: query.isPending, send, abort };
}
