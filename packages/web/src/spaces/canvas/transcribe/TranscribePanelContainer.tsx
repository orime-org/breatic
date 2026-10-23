// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transcribe panel (inner#856): opened from an audio or video node's
 * menu, it holds one choice — whether filler words stay as spoken — and a Run
 * that builds the transcript's text node to the right.
 *
 * It shares the one host and lifecycle every node-anchored panel has, so it
 * closes the way they do: its close key, Escape, another panel, or the node
 * losing the selection (which is what a Run does, by selecting the node it
 * built).
 */

import * as React from 'react';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { CanvasPanel } from '@web/spaces/canvas/_shared/CanvasPanel';
import { NodePanelMount } from '@web/spaces/canvas/_shared/NodePanelMount';
import { PanelRunFooter } from '@web/spaces/canvas/_shared/PanelRunFooter';
import { useCanvasContext, useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { ParamToggleRow } from '@web/spaces/canvas/generate/ParamToggleRow';
import { useTranscribing } from '@web/spaces/canvas/start-understand-run';
import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';
import { useTranscribePreference } from '@web/stores/transcribe-preference';

export interface TranscribePanelContainerProps {
  nodes: readonly CanvasNodeView[];
  /** Transcribe this node, with filler words kept or left out. */
  onRun: (nodeId: string, keepFillers: boolean) => void;
}

/**
 * The open transcribe panel, or nothing while another panel or none is open.
 * @param root0 - Component props.
 * @param root0.nodes - The canvas's node views.
 * @param root0.onRun - Transcribe a node.
 * @returns The panel hung under its node, or null.
 */
export function TranscribePanelContainer({
  nodes,
  onRun,
}: TranscribePanelContainerProps): React.JSX.Element | null {
  const kind = useCanvasSession((s) => s.panelKind);
  const host = useCanvasSession((s) => s.panelHostId);
  if (kind !== 'transcribe' || host === null || !nodes.some((n) => n.id === host)) return null;
  return <OpenTranscribePanel nodeId={host} onRun={onRun} />;
}

interface OpenTranscribePanelProps {
  nodeId: string;
  onRun: TranscribePanelContainerProps['onRun'];
}

/**
 * The panel while it is open on one node.
 * @param root0 - Component props.
 * @param root0.nodeId - The node being transcribed.
 * @param root0.onRun - Transcribe it.
 * @returns The mounted panel.
 */
function OpenTranscribePanel({ nodeId, onRun }: OpenTranscribePanelProps): React.JSX.Element {
  const t = useTranslation();
  const { spaceId } = useCanvasContext();
  const closeActivePanel = useCanvasSession((s) => s.closeActivePanel);
  const keepFillers = useTranscribePreference((s) => s.keepFillers);
  const setKeepFillers = useTranscribePreference((s) => s.setKeepFillers);
  // A press still waiting holds Run (inner#1490); it outlives the panel it
  // was made in, so reopening the panel shows it too.
  const running = useTranscribing(spaceId, nodeId);
  const onRunPress = React.useCallback((): void => onRun(nodeId, keepFillers), [onRun, nodeId, keepFillers]);

  useEscapeInSpace(true, closeActivePanel);

  return (
    <NodePanelMount nodeId={nodeId}>
      <CanvasPanel
        title={
          <span data-testid='transcribe-panel-title' className='text-sm font-semibold'>
            {t('canvas.transcribe.title')}
          </span>
        }
        closeLabel={t('canvas.miniTool.panel.close')}
        closeTestId='transcribe-panel-close'
        onClose={closeActivePanel}
        testId='transcribe-panel'
      >
        <div className='flex flex-col gap-2.5 px-3 pb-2.5'>
          <ParamToggleRow
            id='transcribe-keep-fillers'
            label={t('canvas.transcribe.keepFillers')}
            checked={keepFillers}
            onCheckedChange={setKeepFillers}
          />
          <p data-testid='transcribe-hint' className='text-xs text-muted-foreground'>
            {t(keepFillers ? 'canvas.transcribe.keepFillersOn' : 'canvas.transcribe.keepFillersOff')}
          </p>
        </div>
        <PanelRunFooter
          creditText={t('canvas.miniTool.panel.usage')}
          runLabel={t('canvas.miniTool.panel.run')}
          disabled={false}
          loading={running}
          onRun={onRunPress}
          creditTestId='transcribe-credit'
          runTestId='transcribe-run'
        />
      </CanvasPanel>
    </NodePanelMount>
  );
}
