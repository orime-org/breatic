/**
 * ChatPanel — v13 left-rail chat panel (spec/02 §10.18, mockup
 * `2026-04-27-visual-language/05-canvas-native-tailwind.html` line 1719).
 *
 * Replaces the v12 mock-only `AiChatRecordPanel` with a real
 * end-to-end flow:
 *
 *   user types in `ChatComposer` → click Send (or Cmd+Enter)
 *     → POST `/api/v1/chat/message` SSE
 *     → `useChatStream` consumes `chat_chunk` / `chat_done` /
 *       `agent_choice` / `agent_canvas_action` /
 *       `agent_search_results` / `error` events
 *     → assistant message bubble streams the reply + attaches a
 *       toolCall when the agent emits one (`AgentToolMessage`
 *       renders the matching widget inline)
 *
 * Conversation lifecycle:
 *   - On mount: list this user's conversations (limit 10), find
 *     the most recent one with `projectId === currentProjectId`,
 *     load its history into `useChatStream.messages`. None found
 *     → leave conversation_id undefined; backend `getOrCreate`
 *     mints one on the first send.
 *
 * Chips → backend `attached_chips`:
 *   - User clicks the canvas-pick button in `ChatComposer`
 *     → ChatPanel calls `chipsPick.enterPickMode(handler)`
 *     → ProjectCanvasContent calls `pickNode(nodeId)` on the next
 *       click
 *     → handler reads the node from canvas data, deep-clones
 *       `data` for the chip's `data_snapshot` (spec §10.18.2 v13
 *       C1 frozen-copy model — subsequent canvas edits don't
 *       mutate the chip)
 *
 * Tool-action handlers:
 *   - `onSelectChoice(option)` — sends `option.label` back as a
 *     user message so the LLM sees the user's pick (standard
 *     "follow-up turn" pattern, not a separate API).
 *   - `onAddSearchHit(hit)` — uploads the URL via
 *     `useUploadFiles.uploadOne` then `createDataNode` at viewport
 *     center.
 *   - `onApplyCanvasAction()` — fans out `createDataNode` per
 *     proposed node at viewport center (cascaded by 64px).
 *
 * V12 fallbacks (`addImageFromUrl`, `addResourceFromUrl`,
 * `selectedWorkspaceRegion`, etc.) are NOT carried over — Page.tsx
 * doesn't pass a ref to AiChatRecordPanel, so those imperative
 * methods had no external caller. The legacy `AgentInput` /
 * `AgentComposerTabs` / pickState integrations stay in the tree
 * for B.2 to remove.
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { message as uiMessage } from '@/ui/message';
import { useReactFlow } from '@xyflow/react';
import AgentMessage from '@/features/chat/components/AgentMessage';
import AgentToolMessage from '@/features/chat/components/AgentToolMessage';
import ChatComposer, {
  type ChatChip,
  type ChatChipKind,
} from '@/features/chat/components/ChatComposer';
import EmptyChatRecordState from '@/features/chat/components/EmptyChatRecordState';
import type {
  AgentChoiceOption,
  AgentSearchHit,
  AgentToolArgsProposeCanvasAction,
} from '@/features/chat/components/agent-tool-types';
import { useChipsPick } from '@/features/chat/contexts/ChipsPickContext';
import { useChatStream, type ChatStreamMessage } from '@/features/chat/use-chat-stream';
import { listConversations, getConversation } from '@/data/api/chat';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { uploadOne, NODE_TYPE_BY_KIND } from '@/features/upload';
import { flowCenterFromCanvasPane } from '@/spaces/canvas/types';
import type { ChatAttachedChip, MessageData } from '@breatic/shared';
import { nanoid } from 'nanoid';

interface ChatPanelProps {
  className?: string;
}

/** Convert a backend `MessageData` to the local `ChatStreamMessage` shape. */
function backendToLocal(msg: MessageData): ChatStreamMessage | null {
  if (msg.role !== 'user' && msg.role !== 'assistant') return null;
  return {
    id: nanoid(),
    role: msg.role,
    content: msg.content,
  };
}

/** Map a canvas node `type` field to the chip kind ChatComposer accepts. */
function chipKindFromNodeType(nodeType: string | undefined): ChatChipKind {
  switch (nodeType) {
    case '1001':
      return 'text';
    case '1002':
      return 'image';
    case '1003':
      return 'video';
    case '1004':
      return 'audio';
    case 'generative':
      return 'generative';
    default:
      return 'text';
  }
}

/** Build the backend `attached_chips` payload from local chip state. */
function chipsToBackend(
  chips: ChatChip[],
  nodeLookup: (id: string) => Record<string, unknown> | null,
): ChatAttachedChip[] {
  return chips
    .map<ChatAttachedChip | null>((chip) => {
      const data = nodeLookup(chip.nodeId);
      if (!data) return null;
      // Deep-clone via JSON round-trip so the chip's `data_snapshot`
      // is a true frozen copy (spec §10.18.2 v13 C1). Yjs-backed
      // values are plain JSON-friendly objects after `yMapToNode`,
      // so `JSON.parse(JSON.stringify(...))` is safe here.
      let snapshot: Record<string, unknown>;
      try {
        snapshot = JSON.parse(JSON.stringify(data));
      } catch {
        snapshot = {};
      }
      return {
        id: chip.nodeId,
        type: chip.kind,
        name: chip.name,
        data_snapshot: snapshot,
      };
    })
    .filter((c): c is ChatAttachedChip => c !== null);
}

const ChatPanelComponent: React.FC<ChatPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const activeMgr = useActiveCanvasSpace();
  const { nodes } = useCanvasData();
  const { createDataNode } = useCanvasActions();
  const { screenToFlowPosition } = useReactFlow();
  const chipsPick = useChipsPick();

  const {
    messages,
    streaming,
    setMessages,
    setConversationId,
    send,
  } = useChatStream();

  // Composer state
  const [draft, setDraft] = useState('');
  const [chips, setChips] = useState<ChatChip[]>([]);
  // Per-message UI state for tool widgets — same shape as F14's
  // patch on AiChatRecordPanel.
  const [choiceByMessageId, setChoiceByMessageId] = useState<Record<string, string>>({});
  const [appliedActionByMessageId, setAppliedActionByMessageId] = useState<Record<string, boolean>>({});

  // Auto-scroll the message list to the bottom when content grows.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  /**
   * Load the most-recent conversation matching the active project,
   * if any. Backend `GET /chat/conversations` doesn't support a
   * project_id filter today, so we pull a small page and filter
   * client-side. TODO(B.1-followup): add a server-side `project_id`
   * query so users with many cross-project conversations don't miss
   * theirs.
   */
  const loadHistory = useCallback(async () => {
    if (!activeMgr) return;
    try {
      const listed = await listConversations({ limit: 10 });
      // The axios interceptor unwraps `response.data` so `listed`
      // already matches the API envelope; cast through unknown to
      // re-narrow without hauling in axios types.
      const envelope = listed as unknown as {
        data?: { id: string; projectId: string | null }[];
      };
      const arr = envelope.data ?? [];
      const match = arr.find((c) => c.projectId === activeMgr.projectId);
      if (!match) return;
      const fetched = await getConversation(match.id);
      const conv = fetched as unknown as {
        data?: { conversation: { id: string }; messages: MessageData[] };
      };
      const inner = conv.data;
      if (!inner) return;
      const localMessages = inner.messages
        .map(backendToLocal)
        .filter((m): m is ChatStreamMessage => m !== null);
      setMessages(localMessages);
      setConversationId(inner.conversation.id);
    } catch (err) {
      // Silent fail — empty state is fine. The next send still
      // works (backend `getOrCreate` mints a fresh conversation).
      // eslint-disable-next-line no-console
      console.warn('[ChatPanel] loadHistory failed', err);
    }
  }, [activeMgr, setMessages, setConversationId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** Look up a node's `data` field by id from the live canvas state. */
  const nodeDataLookup = useCallback(
    (id: string): Record<string, unknown> | null => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return null;
      return (node.data ?? {}) as Record<string, unknown>;
    },
    [nodes],
  );

  /** Add a chip from the picked canvas node id. Skips duplicates by `nodeId`. */
  const handlePickedNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const data = (node.data ?? {}) as { name?: string };
      const name = (data.name ?? '').trim() || nodeId.slice(0, 8);
      setChips((prev) => {
        if (prev.some((c) => c.nodeId === nodeId)) return prev;
        return [
          ...prev,
          {
            id: nanoid(),
            nodeId,
            kind: chipKindFromNodeType(node.type),
            name,
          },
        ];
      });
    },
    [nodes],
  );

  const handleEnterSelectMode = useCallback(() => {
    chipsPick.enterPickMode(handlePickedNode);
  }, [chipsPick, handlePickedNode]);

  const handleRemoveChip = useCallback((chipId: string) => {
    setChips((prev) => prev.filter((c) => c.id !== chipId));
  }, []);

  /** Build the attached_chips payload + send to the backend SSE. */
  const handleSend = useCallback(
    async (text: string, _chips: ChatChip[]) => {
      if (!text.trim()) return;
      const projectId = activeMgr?.projectId;
      const attached_chips = chipsToBackend(_chips, nodeDataLookup);
      // Clear composer immediately so the user sees their text
      // committed; if SSE fails the assistant placeholder will
      // surface the error.
      setDraft('');
      setChips([]);
      await send({
        message: text,
        attached_chips,
        ...(projectId ? { project_id: projectId } : {}),
      });
    },
    [activeMgr, nodeDataLookup, send],
  );

  /**
   * F13 follow-through: ChoicePicker selection → re-send the choice
   * label as the next user turn so the LLM observes the pick. The
   * backend doesn't have a separate "submit choice" endpoint; the
   * standard pattern is to fold the choice into a regular
   * follow-up message (spec §10.18.4 v13).
   */
  const handleSelectChoice = useCallback(
    (msgId: string, option: AgentChoiceOption) => {
      setChoiceByMessageId((prev) =>
        prev[msgId] ? prev : { ...prev, [msgId]: option.id },
      );
      void send({
        message: option.label,
        attached_chips: [],
        ...(activeMgr ? { project_id: activeMgr.projectId } : {}),
      });
    },
    [activeMgr, send],
  );

  /**
   * F13 follow-through: SearchResultsGrid Add-to-Space → upload the
   * external URL into permanent storage, then `createDataNode` an
   * image node at viewport center. Uses the same upload + node-
   * creation primitives as F5's left-menu drop so the UX is
   * consistent.
   */
  const handleAddSearchHit = useCallback(
    async (hit: AgentSearchHit) => {
      if (!activeMgr) return;
      try {
        // The agent provides a remote URL; we need to fetch it
        // first (CORS permitting), wrap as File, then upload.
        const res = await fetch(hit.url, { mode: 'cors' });
        if (!res.ok) throw new Error(`fetch ${hit.url}: ${res.status}`);
        const blob = await res.blob();
        const filename = hit.title?.replace(/[^\w.\-]+/g, '_') || `search-${Date.now()}.png`;
        const file = new File([blob], filename, { type: blob.type || 'image/png' });
        const result = await uploadOne(file, { projectId: activeMgr.projectId });
        const nodeType = NODE_TYPE_BY_KIND[result.kind];
        if (!nodeType) {
          uiMessage.warning(t('canvas.chat.searchHitUnsupported', { defaultValue: '暂不支持的搜索结果类型' }));
          return;
        }
        const center = flowCenterFromCanvasPane(
          screenToFlowPosition,
          { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        );
        createDataNode({
          type: nodeType,
          position: { x: center.x, y: center.y },
          data: {
            name: hit.title || filename,
            content: result.fileUrl,
            ...(result.width !== undefined ? { width: result.width } : {}),
            ...(result.height !== undefined ? { height: result.height } : {}),
            ...(result.duration !== undefined ? { duration: result.duration } : {}),
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ChatPanel] add search hit failed', err);
        uiMessage.error(t('canvas.chat.searchHitAddFailed', { defaultValue: '添加搜索结果失败' }));
      }
    },
    [activeMgr, createDataNode, screenToFlowPosition, t],
  );

  /**
   * F13 follow-through: propose_canvas_action Apply → fan out
   * `createDataNode` per proposed node at viewport center
   * (cascaded by 64 px so a 3-node proposal doesn't stack). The
   * agent doesn't tell us the URL, so the spawned nodes are empty
   * — Worker / generative pipelines fill them via downstream
   * mini-tool / generative tasks. (V2 will tighten the contract
   * to require the agent provide initial content.)
   */
  const BATCH_OFFSET = 64;
  const handleApplyCanvasAction = useCallback(
    (msgId: string, args: AgentToolArgsProposeCanvasAction) => {
      if (appliedActionByMessageId[msgId]) return;
      const center = flowCenterFromCanvasPane(
        screenToFlowPosition,
        { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      );
      args.nodes.forEach((n, idx) => {
        const nodeType = chipKindToNodeType(n.type);
        if (!nodeType) return;
        createDataNode({
          type: nodeType,
          position: {
            x: center.x + idx * BATCH_OFFSET,
            y: center.y + idx * BATCH_OFFSET,
          },
          data: { name: n.label },
        });
      });
      setAppliedActionByMessageId((prev) =>
        prev[msgId] ? prev : { ...prev, [msgId]: true },
      );
    },
    [appliedActionByMessageId, createDataNode, screenToFlowPosition],
  );

  // Esc exits chip pick mode.
  useEffect(() => {
    if (!chipsPick.pickMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        chipsPick.exitPickMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chipsPick]);

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className='flex h-12 shrink-0 flex-nowrap items-center justify-end gap-1 border-b border-border-default-base bg-background-default-base px-2'>
        <button
          type='button'
          aria-label={t('chat.panel.newConversation', { defaultValue: 'New conversation' })}
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded transition-colors hover:bg-background-default-secondary'
          onClick={() => {
            // Local clear — backend will mint a new conversation on
            // next send. History panel is a separate task.
            setMessages([]);
            setConversationId(undefined);
          }}
        >
          <Icon name='project-chat-header-tool-icon' width={27} height={25} color='var(--color-icon-secondary)' />
        </button>
      </div>
      <div ref={listRef} className='flex flex-1 min-h-0 flex-col gap-4 overflow-auto px-4 py-4'>
        {messages.length === 0 ? (
          <EmptyChatRecordState />
        ) : (
          messages.map((msg) => {
            const role = msg.role;
            const senderName = role === 'user'
              ? t('chat.panel.you', { defaultValue: 'You' })
              : t('chat.panel.assistant', { defaultValue: 'Assistant' });
            const textBody = msg.pending && !msg.content
              ? t('chat.panel.thinking', { defaultValue: '正在思考…' })
              : msg.content;
            const tool = msg.toolCall;
            const composedContent = tool ? (
              <>
                {textBody ? <div>{textBody}</div> : null}
                <AgentToolMessage
                  toolCall={tool}
                  selectedChoiceId={choiceByMessageId[msg.id]}
                  applied={appliedActionByMessageId[msg.id] === true}
                  onSelectChoice={(option) => handleSelectChoice(msg.id, option)}
                  onAddSearchHit={handleAddSearchHit}
                  onApplyCanvasAction={() => {
                    if (tool.name === 'propose_canvas_action') {
                      handleApplyCanvasAction(msg.id, tool.args);
                    }
                  }}
                />
                {msg.errorMessage ? (
                  <div className='mt-1 text-[11px] text-text-status-error'>
                    {msg.errorMessage}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <span>{textBody}</span>
                {msg.errorMessage ? (
                  <div className='mt-1 text-[11px] text-text-status-error'>
                    {msg.errorMessage}
                  </div>
                ) : null}
              </>
            );
            return (
              <AgentMessage
                key={msg.id}
                role={role}
                senderName={senderName}
                content={composedContent}
              />
            );
          })
        )}
      </div>
      <div className='shrink-0 p-3 pt-0'>
        {chipsPick.pickMode ? (
          <div className='mb-2 rounded-md border border-brand-base bg-brand-500/5 px-3 py-1.5 text-[11px] text-brand-700'>
            {t('canvas.chat.pickModeHint', {
              defaultValue: '点画布上的节点添加为引用,Esc 退出',
            })}
          </div>
        ) : null}
        <ChatComposer
          value={draft}
          onChange={setDraft}
          chips={chips}
          onRemoveChip={handleRemoveChip}
          onEnterSelectMode={handleEnterSelectMode}
          onSend={handleSend}
          disabled={streaming}
        />
      </div>
    </div>
  );
};

/** Map an agent-proposed node type (already a `ChatChipKind`) to the ReactFlow node type id. */
function chipKindToNodeType(kind: ChatChipKind): string | null {
  switch (kind) {
    case 'image':
      return '1002';
    case 'video':
      return '1003';
    case 'audio':
      return '1004';
    case 'text':
      return '1001';
    case 'generative':
      return 'generative';
    default:
      return null;
  }
}

const ChatPanel = memo(ChatPanelComponent);
export default ChatPanel;
