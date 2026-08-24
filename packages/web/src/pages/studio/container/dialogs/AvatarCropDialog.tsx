// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';
import {
  checkAvatarPixels,
  renderAvatarBlob,
} from '@web/pages/studio/container/dialogs/avatar-image';
import {
  imageBoxWithin,
  initialSquareCrop,
  rescaleCrop,
  type ImageBox,
} from '@web/pages/studio/container/dialogs/avatar-crop';
import {
  captureResize,
  moveRect,
  resizeFromCapture,
  toNaturalCrop,
  type CapturedResize,
  type CropHandle,
  type CropRect,
} from '@web/spaces/canvas/focus/crop-math';

/** The four corners are draggable; edges are not, since the ratio is locked. */
const CORNERS: readonly CropHandle[] = ['nw', 'ne', 'se', 'sw'];

const CORNER_POSITION: Readonly<Record<string, string>> = {
  nw: '-left-1 -top-1 cursor-nwse-resize',
  ne: '-right-1 -top-1 cursor-nesw-resize',
  se: '-bottom-1 -right-1 cursor-nwse-resize',
  sw: '-bottom-1 -left-1 cursor-nesw-resize',
};

/** How far one arrow-key press nudges the selection, in display pixels. */
const KEYBOARD_STEP_PX = 4;

/** An in-flight pointer gesture. */
type Gesture =
  | { kind: 'move'; last: { x: number; y: number } }
  | { kind: 'resize'; capture: CapturedResize };

interface AvatarCropDialogProps {
  /** The picked file; `null` keeps the dialog closed. */
  file: File | null;
  /** Whether the produced blob is currently being uploaded. */
  uploading: boolean;
  /** Upload error to show, keeping the user on their crop. */
  error: string | null;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}

/**
 * Crop a picked image down to the square that becomes the studio avatar.
 *
 * The image is shown whole and does not move; the user drags a 1:1 selection
 * over it. The selection is bounded by the image's DRAWN area rather than the
 * frame — an image that does not match the frame's shape is letterboxed, and a
 * selection reaching onto that margin would bake an empty band into the
 * avatar. Everything outside the selection is dimmed, letterbox included,
 * since none of it survives the crop.
 *
 * Measurement waits for a real layout: a dialog that has not been shown
 * measures 0×0, and seeding from that leaves a zero-sized selection that never
 * recovers. A `ResizeObserver` on the image supplies the box the moment one
 * exists, which also covers the window being resized mid-crop.
 *
 * The dimming is `black/40` rather than a theme token on purpose. It sits on
 * top of a photo, not on the page surface, so it should read the same in
 * either theme — a theme-aware token would invert to "lightening" in dark
 * mode. Same reasoning as the white selection border.
 *
 * While an upload is in flight the dialog refuses to close, and a failed
 * upload leaves the crop exactly as it was, so the user can retry without
 * re-doing their work.
 * @param props - The dialog's file, upload state and callbacks.
 * @param props.file - The picked file, or `null` when closed.
 * @param props.uploading - Whether the produced blob is uploading.
 * @param props.error - An upload error to show above the actions.
 * @param props.onCancel - Called when the user dismisses the dialog.
 * @param props.onConfirm - Called with the encoded 512×512 avatar.
 * @returns The crop dialog.
 */
export function AvatarCropDialog({
  file,
  uploading,
  error,
  onCancel,
  onConfirm,
}: AvatarCropDialogProps): React.JSX.Element {
  const t = useTranslation();
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  const gestureRef = React.useRef<Gesture | null>(null);
  const rectRef = React.useRef<CropRect | null>(null);
  // The box as last measured, read inside `measure` — reading the state there
  // would see whatever value the callback closed over, not the latest one.
  const boxRef = React.useRef<ImageBox | null>(null);

  const [box, setBox] = React.useState<ImageBox | null>(null);
  const [rect, setRect] = React.useState<CropRect | null>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [preparing, setPreparing] = React.useState(false);
  const [decodeFailed, setDecodeFailed] = React.useState(false);

  rectRef.current = rect;

  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);

  // Creation and cleanup live in ONE effect, with the URL exposed through
  // state. Minting it during render instead leaves the image pointing at a URL
  // that has already been revoked: StrictMode runs the render phase twice, so
  // two URLs exist, and a cleanup keyed on the surviving one frees the URL
  // actually on screen while the other is never freed at all.
  React.useEffect(() => {
    if (file === null) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // A new file starts a fresh crop; a failed upload keeps the current one,
  // because `file` has not changed.
  React.useEffect(() => {
    setBox(null);
    setRect(null);
    boxRef.current = null;
    // A gesture in progress dies with the dialog. `endGesture` cannot do this
    // for us: closing mid-drag unmounts the element holding pointer capture,
    // so the eventual pointerup lands on whatever is behind and never reaches
    // its handler. A gesture left here would resume on the NEXT image, where
    // the pointer merely hovering drags the selection with no button held.
    gestureRef.current = null;
    setLocalError(null);
    setDecodeFailed(false);
  }, [file]);

  const measure = React.useCallback((): void => {
    const frame = frameRef.current;
    const img = imgRef.current;
    if (!frame || !img) return;
    // Layout measurements, NOT `getBoundingClientRect`: the dialog animates in
    // with a scale transform, which the rect reflects and the ResizeObserver
    // below does not. Measuring through the rect therefore reads ~95% of the
    // real size, and no later layout change ever arrives to correct it.
    const next = imageBoxWithin(
      { width: frame.clientWidth, height: frame.clientHeight },
      {
        left: img.offsetLeft,
        top: img.offsetTop,
        width: img.offsetWidth,
        height: img.offsetHeight,
      },
    );
    if (next === null) return;
    const prevBox = boxRef.current;
    boxRef.current = next;
    setBox((prev) =>
      prev !== null &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.width === next.width &&
      prev.height === next.height
        ? prev
        : next,
    );
    // The dialog animates open, so the first measurement is of a box that is
    // still growing; a selection seeded from it has to travel with the image
    // rather than stay at numbers that no longer describe anything.
    setRect((prev) =>
      prev === null
        ? initialSquareCrop(next)
        : prevBox === null
          ? prev
          : rescaleCrop(prev, prevBox, next),
    );
  }, []);

  React.useEffect(() => {
    const img = imgRef.current;
    if (!img || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
  }, [measure, objectUrl]);

  /**
   * Translate a pointer event into the image's own coordinate space, which is
   * the space every crop-maths function works in.
   * @param event - The pointer event.
   * @returns The position relative to the image's top-left corner.
   */
  const pointAt = React.useCallback(
    (event: React.PointerEvent): { x: number; y: number } => {
      const imgRect = imgRef.current!.getBoundingClientRect();
      return { x: event.clientX - imgRect.left, y: event.clientY - imgRect.top };
    },
    [],
  );

  const handleSurfaceDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (rect === null || uploading) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      gestureRef.current = { kind: 'move', last: pointAt(event) };
    },
    [pointAt, rect, uploading],
  );

  const handleCornerDown = React.useCallback(
    (event: React.PointerEvent<HTMLSpanElement>, handle: CropHandle): void => {
      if (rectRef.current === null || uploading) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      gestureRef.current = {
        kind: 'resize',
        // The anchor is frozen once here rather than re-derived per move:
        // re-deriving it from the mutated rect loses the anchor the moment
        // the cursor crosses it, and the "fixed" corner starts chasing.
        capture: captureResize(rectRef.current, handle),
      };
    },
    [uploading],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent): void => {
      const gesture = gestureRef.current;
      if (gesture === null || box === null) return;
      const bounds = { width: box.width, height: box.height };
      const p = pointAt(event);
      if (gesture.kind === 'move') {
        setRect((prev) =>
          prev === null
            ? prev
            : moveRect(prev, p.x - gesture.last.x, p.y - gesture.last.y, bounds),
        );
        gestureRef.current = { kind: 'move', last: p };
        return;
      }
      setRect(resizeFromCapture(gesture.capture, p, bounds, 1));
    },
    [box, pointAt],
  );

  const endGesture = React.useCallback((): void => {
    gestureRef.current = null;
  }, []);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (box === null || uploading) return;
      const step =
        event.key === 'ArrowLeft'
          ? { dx: -KEYBOARD_STEP_PX, dy: 0 }
          : event.key === 'ArrowRight'
            ? { dx: KEYBOARD_STEP_PX, dy: 0 }
            : event.key === 'ArrowUp'
              ? { dx: 0, dy: -KEYBOARD_STEP_PX }
              : event.key === 'ArrowDown'
                ? { dx: 0, dy: KEYBOARD_STEP_PX }
                : null;
      if (step === null) return;
      event.preventDefault();
      setRect((prev) =>
        prev === null
          ? prev
          : moveRect(prev, step.dx, step.dy, {
            width: box.width,
            height: box.height,
          }),
      );
    },
    [box, uploading],
  );

  const handleConfirm = React.useCallback(async (): Promise<void> => {
    const img = imgRef.current;
    if (!img || rect === null || box === null) return;
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    const pixelProblem = checkAvatarPixels(natural.width, natural.height);
    if (pixelProblem !== null) {
      setLocalError(t(`studio.container.settings.avatarError.${pixelProblem}`));
      return;
    }
    setPreparing(true);
    setLocalError(null);
    try {
      // The selection is in display pixels; the crop has to be expressed in
      // the source's own resolution or it lands somewhere else entirely.
      const crop = toNaturalCrop(
        rect,
        { width: box.width, height: box.height },
        natural,
      );
      onConfirm(await renderAvatarBlob(img, crop));
    } catch {
      setLocalError(t('studio.container.settings.avatarError.encode_failed'));
    } finally {
      setPreparing(false);
    }
  }, [box, onConfirm, rect, t]);

  const busy = uploading || preparing;
  const shown = decodeFailed
    ? t('studio.container.settings.avatarError.not_an_image')
    : (error ?? localError);

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(next) => {
        // Closing mid-upload would leave the request running with nothing
        // listening for its result.
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        data-testid='avatar-crop-dialog'
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('studio.container.settings.avatarCropTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('studio.container.settings.avatarCropHint')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='flex flex-col gap-3'>
          <div
            ref={frameRef}
            className='relative flex h-72 items-center justify-center overflow-hidden rounded-chrome bg-muted'
          >
            {objectUrl === null ? null : (
              <img
                ref={imgRef}
                src={objectUrl}
                alt=''
                draggable={false}
                onLoad={measure}
                // Without this a file the browser cannot decode — a HEIC
                // straight off a phone, a truncated JPEG, anything renamed to
                // .png — never fires `load`, so the box is never measured, the
                // selection never appears, and Confirm stays disabled forever.
                // The user would be left staring at an empty frame with no
                // explanation and only Cancel to press.
                onError={() => setDecodeFailed(true)}
                className='max-h-full max-w-full select-none'
              />
            )}
            {box !== null && rect !== null ? (
              <>
                {/* Dimming, in four pieces around the selection. It covers the
                    letterbox margins too — they are not part of the crop
                    either. Non-interactive so gestures reach the surface. */}
                <div
                  aria-hidden='true'
                  className='pointer-events-none absolute inset-x-0 top-0 bg-black/40'
                  style={{ height: box.y + rect.y }}
                />
                <div
                  aria-hidden='true'
                  className='pointer-events-none absolute inset-x-0 bottom-0 bg-black/40'
                  style={{ top: box.y + rect.y + rect.height }}
                />
                <div
                  aria-hidden='true'
                  className='pointer-events-none absolute left-0 bg-black/40'
                  style={{
                    top: box.y + rect.y,
                    height: rect.height,
                    width: box.x + rect.x,
                  }}
                />
                <div
                  aria-hidden='true'
                  className='pointer-events-none absolute right-0 bg-black/40'
                  style={{
                    top: box.y + rect.y,
                    height: rect.height,
                    left: box.x + rect.x + rect.width,
                  }}
                />
                {/* Gesture surface, exactly the image's drawn area. */}
                <div
                  className='absolute touch-none'
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.width,
                    height: box.height,
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                >
                  {/* `application` is the ARIA role for a widget that draws
                      itself and takes the keyboard over — which is what this
                      is: the arrow keys move the selection. There is no
                      standard role for a two-dimensional selection region, and
                      the lint rules' allow-lists cover only the handful of
                      built-in interactive roles, so the exemption is about
                      their default list rather than about this markup. It is
                      focusable, labelled, keyboard-operable and shows a focus
                      ring. */}
                  {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
                  <div
                    role='application'
                    tabIndex={0}
                    aria-label={t('studio.container.settings.avatarCropRegion')}
                    data-testid='avatar-crop-selection'
                    className='absolute cursor-move border border-white outline-none focus-visible:ring-1 focus-visible:ring-white'
                    style={{
                      left: rect.x,
                      top: rect.y,
                      width: rect.width,
                      height: rect.height,
                    }}
                    onPointerDown={handleSurfaceDown}
                    onKeyDown={handleKeyDown}
                  >
                    {CORNERS.map((corner) => (
                      <span
                        key={corner}
                        aria-hidden='true'
                        className={`absolute h-2.5 w-2.5 touch-none bg-white ${CORNER_POSITION[corner]}`}
                        onPointerDown={(e) => handleCornerDown(e, corner)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={endGesture}
                        onPointerCancel={endGesture}
                      />
                    ))}
                  </div>
                  {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
                </div>
              </>
            ) : null}
          </div>
          {shown === null ? null : (
            <p
              role='alert'
              className='text-xs text-status-error-foreground'
              data-testid='avatar-crop-error'
            >
              {shown}
            </p>
          )}
          <div className='flex items-center justify-end gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={onCancel}
            >
              {t('studio.container.dialog.cancel')}
            </Button>
            <Button
              size='sm'
              disabled={busy || rect === null}
              onClick={() => void handleConfirm()}
              data-testid='avatar-crop-confirm'
            >
              {busy
                ? t('studio.container.settings.avatarUploading')
                : t('studio.container.settings.avatarCropConfirm')}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
