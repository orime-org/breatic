import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';
import './AngleEditorV3Scene.css';

/** Multi-Angle scale level (consistent with the toolbar slider) */
export type AngleCubeScale = 1 | 5 | 10;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Consistent with slider: Rotate 0~315, step 45° */
const rotateStep = 45;
/** Tilt pitch -30~60, step 30° */
const tiltStep = 30;

const snapToGrid = (value: number, min: number, max: number, step: number) => {
  const snapped = Math.round((value - min) / step) * step + min;
  return clamp(snapped, min, max);
};

const normalizeRotate = (value: number) => {
  const full = 360;
  const normalized = ((value % full) + full) % full;
  // rotate grid is 0..315 with 45-degree steps
  return normalized === 360 ? 0 : normalized;
};

const snapRotate = (value: number) => {
  const snapped = Math.round(normalizeRotate(value) / rotateStep) * rotateStep;
  return normalizeRotate(snapped);
};

const meridianYDeg = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165] as const;

const parallels: { w: number; y: number }[] = [
  { w: 144.75, y: 19.5 },
  { w: 144.75, y: -19.5 },
  { w: 129.75, y: 37.5 },
  { w: 129.75, y: -37.5 },
  { w: 105.75, y: 53.25 },
  { w: 105.75, y: -53.25 },
  { w: 75, y: 65.25 },
  { w: 75, y: -65.25 },
];

const cubeScaleToVisualScale: Record<AngleCubeScale, number> = {
  1: 0.9,
  5: 1.1,
  10: 1.3,
};

type AngleEditorV3SceneProps = {
  rotate: number;
  tilt: number;
  cubeScale?: AngleCubeScale;
  imageSrc?: string;
  onRotateChange: (next: number) => void;
  onTiltChange: (next: number) => void;
  className?: string;
};

const AngleEditorV3Scene: React.FC<AngleEditorV3SceneProps> = ({
  rotate,
  tilt,
  cubeScale = 5,
  imageSrc,
  onRotateChange,
  onTiltChange,
  className,
}) => {
  // Rotate: 0~315 (step 45); Tilt: -30~60 (step 30)
  const rotateMin = 0;
  const rotateMax = 315;
  const tiltMin = -30;
  const tiltMax = 60;
  const cubeSize = 92;
  const half = cubeSize / 2;
  const visualScale = cubeScaleToVisualScale[cubeScale];

  const screenBgStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!imageSrc) return undefined;
    return {
      backgroundImage: `url("${imageSrc}")`,
      backgroundSize: '150%',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    };
  }, [imageSrc]);

  const bumpRotate = (delta: number) => {
    onRotateChange(snapRotate(rotate + delta));
  };

  const bumpTilt = (delta: number) => {
    onTiltChange(snapToGrid(tilt + delta, tiltMin, tiltMax, tiltStep));
  };

  const cameraPositionTransform = 'translateZ(75px) scale(1) rotateZ(0deg)';
  const dragPointerIdRef = useRef<number | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; rotate: number; tilt: number } | null>(null);
  const [isDraggingCamera, setIsDraggingCamera] = useState(false);

  // Center is a fixed-orientation reference cube (front face + side letters), does not rotate with rotate/tilt; only Scale level changes overall scaling.
  const cubeWrapperStyle: React.CSSProperties = {
    transition: 'transform 0.1s ease-out',
    transform: `scale(${visualScale}) rotateX(0deg) rotateY(0deg)`,
  };

  const cubeStyle: React.CSSProperties = {
    width: cubeSize,
    height: cubeSize,
    ...({ ['--angle-cube-half']: `${half}px` } as React.CSSProperties),
  };

  // Grid uses rotate=0/tilt=0 as upright baseline (vertex-to-bottom axis vertical); rotate/tilt are layered on top.
  const sphereGridInnerStyle: React.CSSProperties = {
    transform: `rotateY(${rotate}deg) rotateX(${tilt}deg)`,
  };

  const handleCameraPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.angle-editor-direction-btn')) return;
    e.preventDefault();
    dragPointerIdRef.current = e.pointerId;
    dragStartRef.current = { x: e.clientX, y: e.clientY, rotate, tilt };
    setIsDraggingCamera(true);
  };

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (dragPointerIdRef.current == null || e.pointerId !== dragPointerIdRef.current) return;
      const start = dragStartRef.current;
      if (!start) return;

      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const rotateDelta = (dx / 28) * rotateStep;
      const tiltDelta = (-dy / 22) * tiltStep;

      onRotateChange(snapRotate(start.rotate + rotateDelta));
      onTiltChange(snapToGrid(start.tilt + tiltDelta, tiltMin, tiltMax, tiltStep));
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (dragPointerIdRef.current == null || e.pointerId !== dragPointerIdRef.current) return;
      dragPointerIdRef.current = null;
      dragStartRef.current = null;
      setIsDraggingCamera(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [onRotateChange, onTiltChange, rotateMin, rotateMax, tiltMin, tiltMax]);

  return (
    <div className={cn('angle-editor-v3-scene', className)}>
      <div
        className='unified-scene mode-camera'
        style={{ perspective: 1200, cursor: isDraggingCamera ? 'grabbing' : 'grab' }}
      >
        <div className='unified-scene-cube-container as-reference' style={{ zIndex: 0, opacity: 1 }}>
          <div className='angle-editor-scene-cube as-reference'>
            <div className='angle-editor-cube3d-container' style={{ cursor: 'grab' }}>
              <div className='angle-editor-scene-container' style={{ perspective: 1200 }}>
                <div className='angle-editor-cube-wrapper' style={cubeWrapperStyle}>
                  <div className='angle-editor-cube' style={cubeStyle}>
                    <div
                      className={cn('angle-editor-cube-face', 'angle-editor-face-front', imageSrc && 'has-image')}
                      style={{ cursor: 'default' }}
                    >
                      {imageSrc ? (
                        <img className='angle-editor-face-image-content' alt='' src={imageSrc} draggable={false} />
                      ) : (
                        <span className='text-[14px] font-bold text-text-default-tertiary'>F</span>
                      )}
                    </div>
                    <div className='angle-editor-cube-face angle-editor-face-back'>B</div>
                    <div className='angle-editor-cube-face angle-editor-face-right'>R</div>
                    <div className='angle-editor-cube-face angle-editor-face-left'>L</div>
                    <div className='angle-editor-cube-face angle-editor-face-top'>T</div>
                    <div className='angle-editor-cube-face angle-editor-face-bottom'>B</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className='angle-editor-sphere-grid' role='presentation' aria-hidden>
          <div className='angle-editor-sphere-grid-inner' style={sphereGridInnerStyle}>
            {meridianYDeg.map((deg) => (
              <div
                key={`m-y-${deg}`}
                className='angle-editor-sphere-grid-meridian'
                style={{ transform: `rotateY(${deg}deg)` }}
              />
            ))}
            <div className='angle-editor-sphere-grid-meridian' style={{ transform: 'rotateX(90deg)' }} />
            {parallels.map((p, i) => (
              <div
                key={`p-${i}`}
                className='angle-editor-sphere-grid-parallel'
                style={{
                  width: p.w,
                  height: p.w,
                  transform: `translate(-50%, -50%) translateY(${p.y}px) rotateX(90deg)`,
                }}
              />
            ))}
          </div>
          <div className='angle-editor-sphere-grid-helper-vertical' />
        </div>

        <div className='angle-editor-scene-camera' onPointerDown={handleCameraPointerDown}>
          <div
            className='angle-editor-camera-3d-pivot'
            style={{ transformStyle: 'preserve-3d', transform: `rotateX(${tilt}deg) rotateY(${rotate}deg)` }}
          >
            <div
              className='angle-editor-camera-3d-position'
              style={{ transformStyle: 'preserve-3d', transform: cameraPositionTransform }}
            >
              <div
                className='angle-editor-camera-3d-body angle-editor-camera-3d-front'
                style={{ transform: 'translate(-50%, -50%) translateZ(-8px)' }}
              >
                <div className='angle-editor-camera-3d-lens-outer'>
                  <div className='angle-editor-camera-3d-lens-inner' />
                </div>
              </div>
              <div
                className='angle-editor-camera-3d-body angle-editor-camera-3d-back'
                style={{ transform: 'translate(-50%, -50%) translateZ(8px)' }}
              >
                <div className='angle-editor-camera-3d-screen' style={screenBgStyle} />
              </div>
              <div
                className='angle-editor-camera-3d-body angle-editor-camera-3d-top'
                style={{ transform: 'translate(-50%, -50%) rotateX(90deg) translateZ(8.2px)' }}
              >
                <div className='angle-editor-camera-3d-shutter' />
              </div>
              <div
                className='angle-editor-camera-3d-body angle-editor-camera-3d-bottom'
                style={{ transform: 'translate(-50%, -50%) rotateX(-90deg) translateZ(8.2px)' }}
              />
              <div
                className='angle-editor-camera-3d-body angle-editor-camera-3d-side'
                style={{ transform: 'translate(-50%, -50%) rotateY(-90deg) translateZ(11px)' }}
              />
              <div
                className='angle-editor-camera-3d-body angle-editor-camera-3d-side'
                style={{ transform: 'translate(-50%, -50%) rotateY(90deg) translateZ(11px)' }}
              />
              <div
                className='angle-editor-camera-3d-hotshoe'
                style={{
                  left: '50%',
                  top: '50%',
                  transformStyle: 'preserve-3d',
                  transform: 'translate(-50%, -50%) translateY(-12px)',
                }}
              >
                <div className='angle-editor-camera-3d-hotshoe-body' style={{ transform: 'translateZ(2px)' }}>
                  <div className='angle-editor-camera-3d-hotshoe-mount' />
                </div>
              </div>
              <div
                className='angle-editor-camera-3d-line'
                style={{ height: 69, transform: 'translate(-50%, 0px) translateZ(-8px) rotateX(-90deg)' }}
              />
            </div>
          </div>

          <button
            type='button'
            className='angle-editor-direction-btn angle-editor-direction-btn-up'
            aria-label='Tilt up'
            onClick={() => bumpTilt(tiltStep)}
          >
            <Icon name='imageEditor-angle-editor-chevron-up-icon' width={20} height={20} />
          </button>
          <button
            type='button'
            className='angle-editor-direction-btn angle-editor-direction-btn-down'
            aria-label='Tilt down'
            onClick={() => bumpTilt(-tiltStep)}
          >
            <Icon name='imageEditor-angle-editor-chevron-down-icon' width={20} height={20} />
          </button>
          <button
            type='button'
            className='angle-editor-direction-btn angle-editor-direction-btn-left'
            aria-label='Rotate left'
            onClick={() => bumpRotate(-rotateStep)}
          >
            <Icon name='imageEditor-angle-editor-chevron-left-icon' width={20} height={20} />
          </button>
          <button
            type='button'
            className='angle-editor-direction-btn angle-editor-direction-btn-right'
            aria-label='Rotate right'
            onClick={() => bumpRotate(rotateStep)}
          >
            <Icon name='imageEditor-angle-editor-chevron-right-icon' width={20} height={20} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AngleEditorV3Scene;
