// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@web/stores/canvas';
import { useChatStore } from '@web/stores/chat';
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
    useCanvasStore.getState().openGeneratePanel('node-1');
    useCanvasStore.getState().startReferencePick('node-1');
    useCanvasStore.getState().setSelectedNodeIds(['node-1', 'node-2']);
    useCanvasStore.getState().setMinimapVisible(false); // preference
    useCanvasStore.getState().setSnapToGrid(true); // preference

    useUIStore.getState().setActiveOverlayId('members-modal');
    useUIStore.getState().setDrawerOpen(true);
    useUIStore.getState().setSidebarOpen(false); // preference
    useUIStore.getState().setChatPanelCollapsed(true); // preference

    useChatStore.getState().setComposerDraft('half-typed message');
    useChatStore.getState().setActiveConversationId('conv-1');

    useInpaintStore.getState().setMaskDataUrl('data:image/png;base64,AAAA');
    useInpaintStore.getState().beginStroke({ radius: 8, alpha: 1 });
    useInpaintStore.getState().setBrushSize(42); // preference

    useMiniToolStore
      .getState()
      .startSession({ sessionId: 's1', sourceNodeId: 'node-1', toolName: 'crop' });
  });

  it('clears the open Generate panel and pick session (the reported symptom)', () => {
    expect(useCanvasStore.getState().panelHostId).toBe('node-1');
    resetProjectUiStores();
    expect(useCanvasStore.getState().panelHostId).toBeNull();
    expect(useCanvasStore.getState().pickSession).toBeNull();
  });

  it('clears all per-project SESSION state across the five stores', () => {
    resetProjectUiStores();
    const canvas = useCanvasStore.getState();
    expect(canvas.selectedNodeIds).toEqual([]);
    expect(canvas.panelHostId).toBeNull();
    expect(canvas.panelKind).toBeNull();
    expect(canvas.pickSession).toBeNull();

    const ui = useUIStore.getState();
    expect(ui.activeOverlayId).toBeNull();
    expect(ui.drawerOpen).toBe(false);

    const chat = useChatStore.getState();
    expect(chat.composerDraft).toBe('');
    expect(chat.activeConversationId).toBeNull();

    const inpaint = useInpaintStore.getState();
    expect(inpaint.strokes).toEqual([]);
    expect(inpaint.maskDataUrl).toBeNull();
    // Undo history (zundo temporal) is cleared too — a fresh entry can't undo
    // back into the old strokes.
    expect(useInpaintStore.temporal.getState().pastStates).toEqual([]);

    expect(useMiniToolStore.getState().sessions).toEqual({});
  });

  it('KEEPS layout / viewport / brush preferences (fresh session, not fresh preferences)', () => {
    resetProjectUiStores();
    // Canvas viewport preferences.
    expect(useCanvasStore.getState().minimapVisible).toBe(false);
    expect(useCanvasStore.getState().snapToGrid).toBe(true);
    // Chrome layout preferences.
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
    // Brush preference.
    expect(useInpaintStore.getState().brushSize).toBe(42);
  });
});
