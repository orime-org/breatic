// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageData, SSEEventEnvelope } from '@breatic/shared';
import { SSE_EVENT_NAMES } from '@breatic/shared';

import { chatApi } from '@web/data/api/chat';
import { StreamRefusedError } from '@web/data/stream/sse';
import type { OpenChatResult } from '@web/data/api/chat';
import { useChatStore } from '@web/stores';
import type { ChatMessage, ToolCall } from '@web/pages/project/chat/types';

/**
 * A message as the cache holds it.
 *
 * A stored message plus the one state that is local by nature: whether the
 * reply is being written right now. Nothing else here is invented locally —
 * how the turn ended, including its having failed, is recorded on the stored
 * message, so what is on screen and what a reload brings back agree.
 */
type CachedMessage = MessageData & { streaming?: boolean };

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

/** The one refusal a second attempt can do anything about. */
const NOT_FOUND = 404;

export interface ChatSession {
  /** Every message to show, history and the reply in flight alike. */
  messages: ChatMessage[];
  /** True until the server has answered — not the same as an empty chat. */
  isPending: boolean;
  /**
   * Opening the chat failed, so there is no conversation to write to.
   *
   * Distinct from an empty chat, which invites the user to start one. Showing
   * that here is what let a message be typed, sent, and silently dropped.
   */
  failedToOpen: boolean;
  /**
   * There is a conversation to write to, so a message can be sent right now.
   *
   * False while the chat is still opening and after opening failed. The panel
   * turns the composer off on both, because a message typed then has nowhere
   * to go and would be dropped without a word.
   */
  canSend: boolean;
  /**
   * Send one message and stream the reply into the list.
   *
   * Resolves when the whole turn is over, but the message is in the list
   * before the first await — so a caller that has checked `canSend`
   * may treat the call itself as the send having happened.
   * @throws {Error} When there is no conversation to send to — the caller
   *   must not treat that as sent, or the text is gone with nothing said.
   */
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
    ...(message.streaming ? { streaming: true } : {}),
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
  /** The reply currently being written, so ending the turn can unmark it. */
  const activeReplyId = React.useRef<string | null>(null);

  const query = useQuery<CachedChat>({
    queryKey: chatKey(projectId),
    queryFn: () => chatApi.openChat(projectId),
  });

  const conversationId = query.data?.current.conversation.id;

  React.useEffect(() => {
    if (conversationId) setActiveConversationId(conversationId);
  }, [conversationId, setActiveConversationId]);

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

  /**
   * Drop one message from the cache.
   * @param id - The message to drop
   */
  const removeMessage = React.useCallback(
    (id: string): void => {
      queryClient.setQueryData<CachedChat>(chatKey(projectId), (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          current: {
            ...prev.current,
            messages: prev.current.messages.filter((m) => m.id !== id),
          },
        };
      });
    },
    [queryClient, projectId],
  );

  /**
   * The last thing the user said, as the cache holds it.
   * @returns That message, or undefined when they have not said anything
   */
  const lastUserMessage = React.useCallback((): CachedMessage | undefined => {
    const messages = queryClient.getQueryData<CachedChat>(chatKey(projectId))?.current.messages;
    return messages?.filter((m) => m.role === 'user').at(-1);
  }, [queryClient, projectId]);

  /** Leave a failed reply where the answer would have gone. */
  const appendFailedReply = React.useCallback((): void => {
    const last = queryClient.getQueryData<CachedChat>(chatKey(projectId))?.current.messages.at(-1);
    appendMessages([
      {
        id: `local-reply-${crypto.randomUUID()}`,
        role: 'assistant',
        parts: [],
        content: '',
        ts: new Date().toISOString(),
        turnIndex: last?.turnIndex ?? 1,
        failed: true,
      },
    ]);
  }, [queryClient, projectId, appendMessages]);

  /**
   * End the turn in flight, however it ended.
   *
   * Four things end a turn — the server saying so, an error, the user
   * pressing stop, the panel going away — and all four come through here.
   * That is the point: both marks that say "a reply is being written" are
   * cleared in one place, so a path cannot clear one and forget the other.
   * Stopping used to clear only the store's, and the reply kept its blinking
   * cursor for as long as the panel stayed open.
   */
  const finishTurn = React.useCallback((): void => {
    inFlight.current = null;
    if (activeReplyId.current !== null) {
      patchMessage(activeReplyId.current, ({ streaming: _streaming, ...rest }) => rest);
      activeReplyId.current = null;
    }
    setStreaming(false);
  }, [setStreaming, patchMessage]);

  const abort = React.useCallback((): void => {
    // Marked here rather than in finishTurn, because this is the one ending
    // that means the reply was cut off. The server records the same thing on
    // its side, so leaving it out makes the identical message read as a
    // finished answer now and as a stopped one after a reload. It has to
    // happen before finishTurn, which forgets which reply was in flight.
    if (activeReplyId.current !== null) {
      patchMessage(activeReplyId.current, (m) => ({ ...m, interrupted: true as const }));
    }
    inFlight.current?.abort();
    finishTurn();
  }, [finishTurn, patchMessage]);

  // The turn belongs to this mounted panel. Collapsing the chat column
  // unmounts it, and that ends the turn exactly the way pressing stop does:
  // the request is torn down and both marks come off. Without it, pieces of a
  // reply keep arriving for a list nobody is holding, the store keeps showing
  // a stop button for a turn that ended, and the half-written reply keeps its
  // typing cursor when the column is opened again.
  React.useEffect(() => {
    return () => {
      abort();
    };
  }, [abort]);

  /**
   * Run one turn against one conversation.
   * @param text - What the user said
   * @param conversation - The conversation to write it to
   * @param userMessage - The message already on screen for it, when this is a
   *   second attempt after the first conversation turned out to be gone
   * @returns The refusal that ended it, when one did
   */
  const runTurn = React.useCallback(
    async (
      text: string,
      conversation: string,
      userMessage?: CachedMessage,
    ): Promise<StreamRefusedError | undefined> => {
      const now = new Date().toISOString();
      const replyId = `local-reply-${crypto.randomUUID()}`;
      const turnIndex =
        (queryClient.getQueryData<CachedChat>(chatKey(projectId))?.current.messages.at(-1)
          ?.turnIndex ?? 0) + 1;

      const said: CachedMessage = userMessage ?? {
        id: `local-user-${crypto.randomUUID()}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        content: text,
        ts: now,
        turnIndex,
      };

      appendMessages(
        userMessage
          ? [{ id: replyId, role: 'assistant', parts: [], content: '', ts: now, turnIndex, streaming: true }]
          : [
            said,
            { id: replyId, role: 'assistant', parts: [], content: '', ts: now, turnIndex, streaming: true },
          ],
      );

      const controller = new AbortController();
      inFlight.current = controller;
      activeReplyId.current = replyId;
      setStreaming(true);

      let refusal: StreamRefusedError | undefined;

      await chatApi.streamMessage(
        { projectId, conversationId: conversation, message: text },
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
          onError: (err: unknown) => {
            if (err instanceof StreamRefusedError) {
              refusal = err;
            } else {
              patchMessage(replyId, (m) => ({ ...m, failed: true }));
            }
            finishTurn();
          },
        },
      );

      // The reply that was never going to arrive goes, whether this attempt
      // is the end of it or the start of a second one.
      if (refusal) removeMessage(replyId);
      return refusal;
    },
    [projectId, queryClient, appendMessages, patchMessage, removeMessage, setStreaming, finishTurn],
  );

  const send = React.useCallback(
    async (text: string): Promise<void> => {
      // Not a silent return: the composer clears the draft on the strength of
      // this call, so failing quietly means the user's words disappear with no
      // reply, no error and nothing to retry.
      if (!conversationId) {
        throw new Error('chat is not open');
      }

      const refusal = await runTurn(text, conversationId);
      if (!refusal) return;

      // Only one refusal is worth a second try. A conversation can be deleted
      // from another tab while this one still holds its id, and that is not
      // something the user did or can act on; every other refusal — no
      // permission, a project that is gone — says trying again is pointless.
      if (refusal.status !== NOT_FOUND) {
        appendFailedReply();
        return;
      }

      // Opening a fresh one can fail too, and when it does the turn is over
      // with nothing to show for it: the reply was already dropped when the
      // first attempt was refused. Ending here without a word leaves what the
      // user said sitting alone with no answer and no explanation.
      let fresh;
      try {
        fresh = await chatApi.openChat(projectId);
      } catch {
        appendFailedReply();
        return;
      }
      const said = lastUserMessage();

      // The new conversation arrives with what the user said already on it,
      // so their words do not blink out for the frame between the two.
      queryClient.setQueryData<CachedChat>(chatKey(projectId), {
        ...fresh,
        current: {
          ...fresh.current,
          messages: said ? [...fresh.current.messages, said] : fresh.current.messages,
        },
      });

      const secondRefusal = await runTurn(text, fresh.current.conversation.id, said);
      if (secondRefusal) appendFailedReply();
    },
    [conversationId, projectId, queryClient, runTurn, appendFailedReply, lastUserMessage],
  );

  const messages = React.useMemo(
    () => (query.data?.current.messages ?? []).map(toChatMessage),
    [query.data],
  );

  return {
    messages,
    isPending: query.isPending,
    failedToOpen: query.isError,
    canSend: conversationId !== undefined,
    send,
    abort,
  };
}
