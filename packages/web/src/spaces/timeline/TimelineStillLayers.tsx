// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The picture and text layers of the Timeline preview (inner#1709): a picture is an `<img>` decoded off the
 * main thread, ready once `decode()` resolves; a text is a block whose body is written as text, never as markup, in the
 * preview's prefixed font stack, sized by the shown frame height.
 */

import * as React from 'react';
import { TIMELINE_TEXT_STYLE, timelineLayerStyle, type TimelineLayerBox, type TimelineLayerTransform } from '@breatic/shared';

import { TIMELINE_TEXT_FONT_STACK } from '@web/spaces/timeline/timeline-text-fonts';

/** A picture layer's load state. */
export type TimelineImageState = 'loading' | 'ready' | 'failed';

/** One picture layer. */
interface TimelineImageLayerProps {
  clipId: string;
  src: string;
  /** Its box and transform in display pixels; null while its size is unknown. */
  box: React.CSSProperties | null;
  z: number;
  shown: boolean;
  onState: (clipId: string, state: TimelineImageState, size: { width: number; height: number } | null) => void;
}

/**
 * A picture placed in the frame; it reports when its decode settles, with its decoded size.
 * @param props - The layer.
 * @param props.clipId - Its clip.
 * @param props.src - Its file.
 * @param props.box - Its placed box.
 * @param props.z - Its stacking order.
 * @param props.shown - Whether it is visible now; a premounted picture waits hidden.
 * @param props.onState - Receives its state.
 * @returns The image.
 * @throws {never} Never.
 */
export const TimelineImageLayer = React.memo(function TimelineImageLayer({ clipId, src, box, z, shown, onState }: TimelineImageLayerProps): React.JSX.Element {
  const image = React.useRef<HTMLImageElement>(null);
  React.useEffect(() => {
    const element = image.current;
    if (element === null) return undefined;
    let current = true;
    onState(clipId, 'loading', null);
    element.decode().then(() => {
      if (current) onState(clipId, 'ready', { width: element.naturalWidth, height: element.naturalHeight });
    }, () => {
      if (current) onState(clipId, 'failed', null);
    });
    return () => { current = false; };
  }, [clipId, src, onState]);
  const style = React.useMemo((): React.CSSProperties => ({
    ...box, position: 'absolute', objectFit: 'contain', pointerEvents: 'none', zIndex: z, visibility: shown && box !== null ? undefined : 'hidden',
  }), [box, z, shown]);
  return <img ref={image} data-clip-id={clipId} src={src} alt='' decoding='async' draggable={false} style={style} />;
});

/** One text layer. */
interface TimelineTextLayerProps {
  clipId: string;
  body: string;
  /** The font size in display pixels. */
  fontSize: number;
  /** The widest it may be: the shown frame width. */
  maxWidth: number;
  canvas: { width: number; height: number };
  transform: TimelineLayerTransform;
  factor: number;
  z: number;
  onSize: (clipId: string, size: { width: number; height: number }) => void;
}

const NO_BOX: TimelineLayerBox = { left: 0, top: 0, width: 0, height: 0 };

/**
 * A text centred in the frame, then moved by its transform; it reports the size it renders at, its layer's base box.
 * @param props - The layer.
 * @param props.clipId - Its clip.
 * @param props.body - The words, written as text.
 * @param props.fontSize - Its size in display pixels.
 * @param props.maxWidth - The shown frame width.
 * @param props.canvas - The frame size.
 * @param props.transform - Its stored or live placement.
 * @param props.factor - Display pixels per canvas pixel.
 * @param props.z - Its stacking order.
 * @param props.onSize - Receives its rendered size in display pixels.
 * @returns The text.
 * @throws {never} Never.
 */
export const TimelineTextLayer = React.memo(function TimelineTextLayer({ clipId, body, fontSize, maxWidth, canvas, transform, factor, z, onSize }: TimelineTextLayerProps): React.JSX.Element {
  const element = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const node = element.current;
    if (node === null) return undefined;
    /**
     * Report the rendered size; the transform does not change it.
     * @throws {never} Never.
     */
    const measure = (): void => { onSize(clipId, { width: node.offsetWidth, height: node.offsetHeight }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [clipId, onSize]);
  const style = React.useMemo((): React.CSSProperties => ({
    ...TIMELINE_TEXT_STYLE, position: 'absolute', left: '50%', top: '50%', width: 'max-content', maxWidth, fontSize, fontFamily: TIMELINE_TEXT_FONT_STACK,
    pointerEvents: 'none', zIndex: z, overflowWrap: 'anywhere',
    transform: `translate(-50%, -50%) ${timelineLayerStyle(canvas, NO_BOX, transform, factor).transform}`,
  }), [maxWidth, fontSize, canvas, transform, factor, z]);
  return <div ref={element} data-clip-id={clipId} style={style}>{body}</div>;
});
