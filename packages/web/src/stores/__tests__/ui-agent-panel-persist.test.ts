// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';

import { readAgentPanelOpen, writeAgentPanelOpen } from '@web/lib/project-tabs-storage';
import { useUIStore } from '@web/stores/ui';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const P1 = 'project-one';
const P2 = 'project-two';

describe('useUIStore — the Agent panel remembered per account and project', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUIStore.setState(useUIStore.getInitialState());
  });

  it('opens the panel where nothing is stored', () => {
    useUIStore.setState({ chatPanelCollapsed: true });
    useUIStore.getState().restoreAgentPanel(ALICE, P1);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
  });

  it('restores what this account left in this project', () => {
    writeAgentPanelOpen(ALICE, P1, false);
    writeAgentPanelOpen(BOB, P1, true);

    useUIStore.getState().restoreAgentPanel(ALICE, P1);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);

    useUIStore.getState().restoreAgentPanel(BOB, P1);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
  });

  it('writes every change to the restored account and project', () => {
    useUIStore.getState().restoreAgentPanel(ALICE, P1);

    useUIStore.getState().toggleChatPanel();
    expect(readAgentPanelOpen(ALICE, P1)).toBe(false);

    useUIStore.getState().setChatPanelCollapsed(false);
    expect(readAgentPanelOpen(ALICE, P1)).toBe(true);
    expect(readAgentPanelOpen(ALICE, P2)).toBeUndefined();
  });

  it('writes to the project restored last', () => {
    useUIStore.getState().restoreAgentPanel(ALICE, P1);
    useUIStore.getState().restoreAgentPanel(ALICE, P2);

    useUIStore.getState().toggleChatPanel();

    expect(readAgentPanelOpen(ALICE, P2)).toBe(false);
    expect(readAgentPanelOpen(ALICE, P1)).toBeUndefined();
  });

  it('writes nothing before a project is restored', () => {
    useUIStore.getState().toggleChatPanel();
    expect(window.localStorage.length).toBe(0);
  });
});
