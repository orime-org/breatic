// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@web/stores/canvas';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { useConversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';
import { useUIStore } from '@web/stores/ui';
import { canvasSessions } from '@web/stores/canvas-session';
import { toast } from '@web/lib/toast';

/**
 * #1771 — leaving a project must clear its per-user UI session state so re-entry
 * is fresh (the reported symptom: the Generate panel stays open on re-entry).
 * The stores are module singletons that survive unmount, so `resetProjectUiStores`
 * is the explicit teardown. It must clear SESSION state while KEEPING preferences.
 */
describe('resetProjectUiStores (#1771)', () => {
  beforeEach(() => {
    // Start each case from a known-dirty state exercising all four stores.
    canvasSessions.of('s').getState().openGeneratePanel('node-1', 'image');
    canvasSessions.of('s').getState().startReferencePick('node-1');
    useCanvasStore.getState().setSelectedNodeIds(['node-1', 'node-2']);
    useCanvasStore.getState().setMinimapVisible(false); // preference
    useCanvasStore.getState().setSnapToGrid(true); // preference

    useUIStore.getState().setActiveOverlayId('members-modal');
    useUIStore.getState().setDrawerOpen(true);
    useUIStore.getState().setActiveRegion('agent');
    useUIStore.getState().setSidebarOpen(false); // preference
    useUIStore.getState().setChatPanelCollapsed(true); // preference
  });

  it('clears the open Generate panel and pick session (the reported symptom)', () => {
    expect(canvasSessions.of('s').getState().panelHostId).toBe('node-1');
    resetProjectUiStores('project-1');
    expect(canvasSessions.of('s').getState().panelHostId).toBeNull();
    expect(canvasSessions.of('s').getState().pickSession).toBeNull();
  });

  it('clears all per-project SESSION state across the four stores', () => {
    resetProjectUiStores('project-1');
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
    const session = canvasSessions.of('s').getState();
    expect(session.panelHostId).toBeNull();
    expect(session.panelKind).toBeNull();
    expect(session.pickSession).toBeNull();

    const ui = useUIStore.getState();
    expect(ui.activeOverlayId).toBeNull();
    expect(ui.drawerOpen).toBe(false);
    // Back to the space, so the next project opens with its canvas answering
    // the keyboard before anything has been clicked (#168, A9).
    expect(ui.activeRegion).toBe('space');
  });

  it('KEEPS layout / viewport preferences (fresh session, not fresh preferences)', () => {
    resetProjectUiStores('project-1');
    // Canvas viewport preferences.
    expect(useCanvasStore.getState().minimapVisible).toBe(false);
    expect(useCanvasStore.getState().snapToGrid).toBe(true);
    // Chrome layout preferences.
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
  });

  /**
   * The 3D proposal mailbox belongs to this project: leaving forgets both the
   * 3D Space that was receiving and a proposal it had not taken yet, without a
   * toast, so nothing opens a dialog in the next project (inner#1691, design
   * §6.2 · §8.5).
   */
  it('forgets the 3D proposal receiver and the proposal not yet taken, saying nothing', async () => {
    // Imported by a runtime path so the store's absence fails this case alone,
    // leaving the cases above running.
    const storePath = '@web/stores/scene-proposals';
    const { useSceneProposals } = (await import(/* @vite-ignore */ storePath)) as typeof import('@web/stores/scene-proposals');
    useSceneProposals.getState().setListening(true);
    useSceneProposals.getState().request({
      source: 'agent',
      origin: 'agent',
      mode: 't23d',
      prompt: 'A wooden chair',
      params: { texture: true, negative_prompt: '' },
      images: [],
    });
    expect(useSceneProposals.getState().listening).toBe(true);
    expect(useSceneProposals.getState().incoming).not.toBeNull();
    const warning = vi.spyOn(toast, 'warning');

    resetProjectUiStores('project-1');

    expect(useSceneProposals.getState().listening).toBe(false);
    expect(useSceneProposals.getState().incoming).toBeNull();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  /**
   * The conversation runtime is not one of the four above: what it holds is a
   * turn that may be running and a list of messages, neither of which is
   * panel state. It is torn down from the same place because leaving is the
   * same act -- and because this one line is the only thing that stops a turn
   * for a project the user has walked away from. What the runtime does when
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
          agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' },
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
