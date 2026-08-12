// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageData, SSEEventEnvelope } from '@breatic/shared';
import { SSE_EVENT_NAMES, newId } from '@breatic/shared';

import { chatApi } from '@web/data/api/chat';
import {
  StreamRefusedError,
  StreamUnreachableError,
  StreamDroppedError,
} from '@web/data/stream/sse';
import type { OpenChatResult } from '@web/data/api/chat';
import { useChatStore } from '@web/stores';
import type { ChatMessage, ToolCall } from '@web/pages/project/chat/types';

/**
 * A message as the cache holds it.
 *
 * A stored message plus whether its reply is being written right now. That
 * one is local — the server has no such state — but it lasts exactly as long
 * as the message it is on, which is what makes the cache the right place for
 * it. "It just failed, in front of you" does not: it is true of one moment,
 * and is kept in this panel's own state instead.
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
   *
   * Also distinct from a later attempt failing over a conversation already on
   * screen: that one is still open and still readable, and saying it never
   * opened would take every bubble off the screen and tell the reader their
   * history is gone.
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
 * @param justFailed - This failure is happening now, with the reader waiting
 *   on it, rather than being read back out of the history
 * @returns The same message in the panel's shape
 */
function toChatMessage(message: CachedMessage, justFailed: boolean): ChatMessage {
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
    ...(justFailed ? { failedJustNow: true as const } : {}),
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
  /**
   * The reply whose failure the reader is living through, if any.
   *
   * Held here rather than on the message, because it is true of this panel
   * for as long as it stays open and of nothing else. Storing it alongside
   * the message would outlive that by every measure: the cache survives the
   * panel being collapsed, so opening the column again would find a failure
   * from ten minutes ago still claiming to be happening, and read it out to
   * a screen reader as if it had just arrived.
   */
  const [justFailed, setJustFailed] = React.useState<string | null>(null);

  // While a turn is being written, this cache is the only place it exists:
  // its two messages were put here by hand, and every piece of the reply is
  // appended to one of them. The server has no record of any of it until the
  // turn ends. A refetch mid-reply therefore replaces the whole list with one
  // that does not contain this turn — taking it off the screen while it is
  // still arriving, after which every remaining piece is written to a message
  // that is no longer there and the reply never appears again.
  //
  // Only the one trigger that is on by default: `refetchOnReconnect` defaults
  // to true, so it is the one a turn has to be protected from. Naming the
  // others "to be explicit" is not free — window focus is off client-wide,
  // and passing a predicate here would turn it back on for this query alone,
  // which is the opposite of a guard. `refetchOnMount` is left alone too: a
  // hook that is only just mounting has no turn of its own to lose.
  const noTurnInFlight = React.useCallback((): boolean => inFlight.current === null, []);

  const query = useQuery<CachedChat>({
    queryKey: chatKey(projectId),
    queryFn: () => chatApi.openChat(projectId),
    refetchOnReconnect: noTurnInFlight,
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

  /**
   * End the turn in flight, however it ended.
   *
   * Four things end a turn — the server saying so, an error, the user
   * pressing stop, the panel going away — and all four come through here.
   * That is the point: both marks that say "a reply is being written" are
   * cleared in one place, so a path cannot clear one and forget the other.
   * Stopping used to clear only the store's, and the reply kept its blinking
   * cursor for as long as the panel stayed open.
   *
   * An ending names the turn it belongs to, because they do not always arrive
   * while that turn is still the current one. The server finishes a failed
   * turn by sending `error` and only then writing it down and charging for it
   * — the composer is live again for the whole of that, so the next turn can
   * already be under way when `chat_done` lands. An ending that does not say
   * which turn it is would end whichever one is running: a send button over a
   * reply still being written, and a request nothing can stop any more.
   * @param turn - The reply this ending belongs to. Omitted by the caller
   *   that means "whatever is running now" — pressing stop, or the panel
   *   going away.
   */
  const finishTurn = React.useCallback((turn?: string): void => {
    if (turn !== undefined && turn !== activeReplyId.current) return;
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
    ): Promise<StreamRefusedError | StreamUnreachableError | undefined> => {
      // A new turn is under way, so whatever failed before it is no longer
      // what is happening — it has become part of the history, and the
      // failure being announced from here on is this turn's, if it has one.
      setJustFailed(null);

      // From here the local cache is the only place this turn exists: its two
      // messages are about to be written into it by hand, and the server has
      // no record of any of it until the turn ends. So the local one is the
      // one that is right, and anything that disagrees has to give way.
      //
      // A request already on its way back asked about a world without this
      // turn in it, which makes its answer wrong the moment this line runs.
      // Cancelling is what TanStack Query offers for exactly this — it is
      // step one of the optimistic-update guide — and a cancelled fetch never
      // writes. The predicate on `refetchOnReconnect` above covers the other
      // direction: no new fetch starts while the turn runs.
      await queryClient.cancelQueries({ queryKey: chatKey(projectId) });
      const now = new Date().toISOString();
      // `newId` and not `crypto.randomUUID`: same v4 shape, but it is the
      // generator the rest of the app uses, and it works outside a secure
      // context where `crypto.randomUUID` is undefined.
      const replyId = `local-reply-${newId()}`;
      const turnIndex =
        (queryClient.getQueryData<CachedChat>(chatKey(projectId))?.current.messages.at(-1)
          ?.turnIndex ?? 0) + 1;

      const said: CachedMessage = userMessage ?? {
        id: `local-user-${newId()}`,
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
      let unreachable: StreamUnreachableError | undefined;

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
                finishTurn(replyId);
                break;

              case SSE_EVENT_NAMES.ERROR:
                // What the server says here is a hardcoded English sentence;
                // the panel shows its own wording, so only the fact matters.
                //
                // Two marks, because they say different things and last for
                // different lengths of time. `failed` is stored and comes
                // back with the history. The second is this panel's record
                // that the failure happened just now, with someone waiting on
                // it — which is what lets the bubble announce this one to a
                // screen reader without announcing every past failure the
                // moment the panel opens.
                patchMessage(replyId, (m) => ({ ...m, failed: true }));
                setJustFailed(replyId);
                finishTurn(replyId);
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
          onClose: () => finishTurn(replyId),
          onError: (err: unknown) => {
            // Three endings, and the panel can only say something true about
            // one it can tell from the others.
            if (err instanceof StreamRefusedError) {
              // The server answered and said no. Nothing was stored — it
              // writes the user's own message inside the turn, which never
              // ran — so there is nothing to leave on screen either.
              refusal = err;
            } else if (err instanceof StreamUnreachableError) {
              // The request never left. Same as above: no record anywhere, so
              // this is not something that was stopped, it is something that
              // was never sent. `send` reports it and the composer takes the
              // words back.
              unreachable = err;
            } else if (err instanceof StreamDroppedError && activeReplyId.current === replyId) {
              // The stream opened and then died. The server sees that as the
              // client going away and cannot tell it from the user pressing
              // stop, so it records the turn as stopped and this says the
              // same. Guarded on the turn still being the live one: a late
              // error belongs to nothing that is still running.
              patchMessage(replyId, (m) => ({ ...m, interrupted: true as const }));
            }
            finishTurn(replyId);
          },
        },
      );

      // Nothing the server kept, nothing left on screen. Both of these mean
      // the turn never ran, so it stored neither the reply nor the message
      // the user typed — leaving either behind would show a conversation the
      // server does not have, and a reload would quietly disagree.
      if (refusal || unreachable) {
        removeMessage(replyId);
        // Not on the second attempt: that one is re-sending a message which
        // is already on screen and belongs to the caller.
        if (!userMessage && said.id) removeMessage(said.id);
      }
      return refusal ?? unreachable;
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

      const ending = await runTurn(text, conversationId);
      if (!ending) return;

      // It never left the machine. Nothing was stored and nothing is left on
      // screen, so the only honest thing is to say it was not sent and give
      // the words back — which is what throwing does here.
      if (ending instanceof StreamUnreachableError) throw ending;

      // Only one refusal is worth a second try. A conversation can be deleted
      // from another tab while this one still holds its id, and that is not
      // something the user did or can act on; every other refusal — no
      // permission, a project that is gone — says trying again is pointless,
      // and the server kept no record of the attempt either.
      if (ending.status !== NOT_FOUND) throw ending;

      // Opening a fresh one can fail too, and when it does the turn is over
      // with nothing to show for it: the reply was already dropped when the
      // first attempt was refused. Ending here without a word leaves what the
      // user said sitting alone with no answer and no explanation.
      // The conversation is gone and a fresh one cannot be opened either.
      // Nothing was stored for this attempt, so the same rule applies as
      // above: let it out, and the composer hands the words back. Catching it
      // here to make up a reply would put a turn on screen the server has no
      // record of.
      const fresh = await chatApi.openChat(projectId);
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

      const secondEnding = await runTurn(text, fresh.current.conversation.id, said);
      if (secondEnding) throw secondEnding;
    },
    [conversationId, projectId, queryClient, runTurn, lastUserMessage],
  );

  // What the panel was handed for each stored message last time round.
  //
  // Every piece of a reply replaces the cache entry, so this runs once per
  // token. Rebuilding all of it each time hands every bubble in the column a
  // new object, and a conversation is only ever appended to — one message is
  // changing and the rest were settled long ago. Keyed on the stored message
  // itself, which `patchMessage` leaves untouched for everything it is not
  // rewriting, so identity is exactly the question "did this one change".
  const rendered = React.useRef(new Map<CachedMessage, ChatMessage>());

  const messages = React.useMemo(() => {
    const kept = new Map<CachedMessage, ChatMessage>();
    const out = (query.data?.current.messages ?? []).map((m) => {
      const justNow = m.id === justFailed;
      const before = rendered.current.get(m);
      // The second half matters on the one message whose failure has just
      // stopped being news: nothing about it changed except that.
      const view = before && Boolean(before.failedJustNow) === justNow
        ? before
        : toChatMessage(m, justNow);
      kept.set(m, view);
      return view;
    });
    rendered.current = kept;
    return out;
  }, [query.data, justFailed]);

  return {
    messages,
    isPending: query.isPending,
    // Only when there is nothing to show for it. A later attempt failing over
    // a conversation that is already here leaves that conversation exactly as
    // it was.
    failedToOpen: query.isError && query.data === undefined,
    canSend: conversationId !== undefined,
    send,
    abort,
  };
}
