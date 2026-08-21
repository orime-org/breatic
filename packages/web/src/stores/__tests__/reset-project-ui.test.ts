// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@web/stores/canvas';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { useConversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { useInpaintStore } from '@web/stores/inpaint';
import { useMiniToolStore } from '@web/stores/mini-tool';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';
import { useUIStore } from '@web/stores/ui';

/**
 * #1771 — leaving a project must clear its per-user UI session state so re-entry
 * is fresh (the reported symptom: the Generate panel stays open on re-entry).
 * The stores are module singletons that survive unmount, so `resetProjectUiStores`
 * is the explicit teardown. It must clear SESSION state while KEEPING preferences.
 */
describe('resetProjectUiStores (#1771)', () => {
  beforeEach(() => {
    // Start each case from a known-dirty state exercising all five stores.
    useCanvasStore.getState().openGeneratePanel('node-1', 'image');
    useCanvasStore.getState().startReferencePick('node-1');
    useCanvasStore.getState().setSelectedNodeIds(['node-1', 'node-2']);
    useCanvasStore.getState().setMinimapVisible(false); // preference
    useCanvasStore.getState().setSnapToGrid(true); // preference

    useUIStore.getState().setActiveOverlayId('members-modal');
    useUIStore.getState().setDrawerOpen(true);
    useUIStore.getState().setSidebarOpen(false); // preference
    useUIStore.getState().setChatPanelCollapsed(true); // preference


    useInpaintStore.getState().setMaskDataUrl('data:image/png;base64,AAAA');
    useInpaintStore.getState().beginStroke({ radius: 8, alpha: 1 });
    useInpaintStore.getState().setBrushSize(42); // preference

    useMiniToolStore
      .getState()
      .startSession({ sessionId: 's1', sourceNodeId: 'node-1', toolName: 'crop' });
  });

  it('clears the open Generate panel and pick session (the reported symptom)', () => {
    expect(useCanvasStore.getState().panelHostId).toBe('node-1');
    resetProjectUiStores('project-1');
    expect(useCanvasStore.getState().panelHostId).toBeNull();
    expect(useCanvasStore.getState().pickSession).toBeNull();
  });

  it('clears all per-project SESSION state across the five stores', () => {
    resetProjectUiStores('project-1');
    const canvas = useCanvasStore.getState();
    expect(canvas.selectedNodeIds).toEqual([]);
    expect(canvas.panelHostId).toBeNull();
    expect(canvas.panelKind).toBeNull();
    expect(canvas.pickSession).toBeNull();

    const ui = useUIStore.getState();
    expect(ui.activeOverlayId).toBeNull();
    expect(ui.drawerOpen).toBe(false);


    const inpaint = useInpaintStore.getState();
    expect(inpaint.strokes).toEqual([]);
    expect(inpaint.maskDataUrl).toBeNull();
    // Undo history (zundo temporal) is cleared too — a fresh entry can't undo
    // back into the old strokes.
    expect(useInpaintStore.temporal.getState().pastStates).toEqual([]);

    expect(useMiniToolStore.getState().sessions).toEqual({});
  });

  it('KEEPS layout / viewport / brush preferences (fresh session, not fresh preferences)', () => {
    resetProjectUiStores('project-1');
    // Canvas viewport preferences.
    expect(useCanvasStore.getState().minimapVisible).toBe(false);
    expect(useCanvasStore.getState().snapToGrid).toBe(true);
    // Chrome layout preferences.
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
    // Brush preference.
    expect(useInpaintStore.getState().brushSize).toBe(42);
  });

  /**
   * The conversation runtime is not one of the five above: what it holds is a
   * turn that may be running and a list of messages, neither of which is
   * panel state. It is torn down from the same place because leaving is the
   * same act -- and because this one line is the only thing that stops a turn
   * for a project the reader has walked away from. What the runtime does when
   * it is told to is pinned in its own file; what is pinned here is that it
   * gets told at all.
   */
  it('tells the conversation runtime the project is being left', async () => {
    _resetForTests();
    evictAllChatSessions();
    let sent: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );
    useConversationRuntime.setState({
      conversations: {
        'c-1': {
          projectId: 'project-1',
          messages: [],
          hasMore: false,
          oldestLoadedTurn: 1,
          title: null,
        },
      },
      currentByProject: { 'project-1': 'c-1' },
      openStatus: { 'project-1': 'ready' },
    });
    void chatSessionFor({
      projectId: 'project-1',
      conversationId: 'c-1',
      history: [],
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    }).sendMessage({ text: '在跑的一轮' });
    await vi.waitFor(() => {
      expect(sent).toBeDefined();
    });

    resetProjectUiStores('project-1');

    // Stopped, because once the project is off the screen there is no stop
    // button anywhere for this turn.
    expect(sent?.aborted).toBe(true);
    expect(useConversationRuntime.getState().conversations['c-1']).toBeUndefined();
    expect(useConversationRuntime.getState().openStatus['project-1']).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
