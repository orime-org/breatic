// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { checkerboardStyle } from '@web/spaces/canvas/_shared/checkerboard';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import { useResolvedVideoPresentation } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';

export interface VideoResultPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The result's registered original. */
  url: string;
  /** The result node's name, the dialog's title. */
  name: string;
}

/**
 * The result player: the selected presentation of the result, transparent areas showing the checkerboard.
 * @param props - The result.
 * @param props.projectId - The Project.
 * @param props.url - The result's registered original.
 * @returns The player.
 * @throws {never} Read failures stay on the player.
 */
function ResultPlayer(props: { projectId: string; url: string }): React.JSX.Element {
  const { source } = useResolvedVideoPresentation(props.projectId, props.url, true);
  return <div className='overflow-hidden rounded-chrome border border-border' style={checkerboardStyle(1, { x: 0, y: 0 })}>
    <MediaPlayer modality='video' src={props.url} videoSource={source} variant='preview' />
  </div>;
}

/**
 * Previews a remove-background result in a dialog (canvas design §4 remove-background row: the checkerboard shows the subject
 * and the transparent areas), with play, pause and seek.
 * @param props - The result and the dialog state.
 * @returns The dialog.
 * @throws {never} Never.
 */
export function VideoResultPreviewDialog(props: VideoResultPreviewDialogProps): React.JSX.Element {
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent data-testid='video-result-preview' aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{props.name}</DialogTitle></DialogHeader>
      <DialogBody>{props.open ? <ResultPlayer projectId={props.projectId} url={props.url} /> : null}</DialogBody>
    </DialogContent>
  </Dialog>;
}
