import React, { useMemo, useRef } from 'react';

export type AngleCubeScale = 1 | 5 | 10;

type AngleCubeControlProps = {
  rotate: number;
  tilt: number;
  /** Cube scale level: 1=small, 5=medium, 10=large (consistent with the Multi-Angle Scale slider) */
  cubeScale?: AngleCubeScale;
  imageSrc?: string;
  onRotateChange: (next: number) => void;
  onTiltChange: (next: number) => void;
  className?: string;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const AngleCubeControl: React.FC<AngleCubeControlProps> = ({
  rotate,
  tilt,
  cubeScale = 5,
  imageSrc,
  onRotateChange,
  onTiltChange,
  className,
}) => {
  const draggingRef = useRef(false);
  const startRef = useRef<{ x: number; y: number; rotate: number; tilt: number } | null>(null);

  // Keep this consistent with the sliders in MultiAngleBottomToolbar.
  const rotateMin = -90;
  const rotateMax = 90;
  const tiltMin = -45;
  const tiltMax = 45;

  // Keep this comfortably inside the 220x220 left panel.
  const cubeSize = 92;
  const half = cubeSize / 2;

  const sensitivity = 0.25; // px -> deg

  // Levels 1 / 5 / 10 map to CSS scale values (5 is medium, close to the old fixed scale(1.2) feel)
  const cubeScaleToVisualScale: Record<AngleCubeScale, number> = {
    1: 0.52,
    5: 1.22,
    10: 1.58,
  };
  const visualScale = cubeScaleToVisualScale[cubeScale];

  const faces = useMemo(
    () => [
      { key: 'front', label: 'F', transform: `translateZ(${half}px)` },
      { key: 'back', label: 'B', transform: `rotateY(180deg) translateZ(${half}px)` },
      { key: 'right', label: 'R', transform: `rotateY(90deg) translateZ(${half}px)` },
      { key: 'left', label: 'L', transform: `rotateY(-90deg) translateZ(${half}px)` },
      { key: 'top', label: 'T', transform: `rotateX(90deg) translateZ(${half}px)` },
      { key: 'bottom', label: 'B', transform: `rotateX(-90deg) translateZ(${half}px)` },
    ],
    [half],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left click / primary touch only
    draggingRef.current = true;
    startRef.current = { x: e.clientX, y: e.clientY, rotate, tilt };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;

    const nextRotate = clamp(Math.round(startRef.current.rotate + dx * sensitivity), rotateMin, rotateMax);
    const nextTilt = clamp(Math.round(startRef.current.tilt - dy * sensitivity), tiltMin, tiltMax);

    onRotateChange(nextRotate);
    onTiltChange(nextTilt);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    startRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={
        className
          ? `${className} flex items-center justify-center select-none cursor-grab active:cursor-grabbing`
          : 'flex items-center justify-center select-none cursor-grab active:cursor-grabbing'
      }
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role='application'
      aria-label='Angle cube control'
    >
      <div className='relative' style={{ perspective: 600 }}>
        <div
          className='relative'
          style={{
            width: cubeSize,
            height: cubeSize,
            transformStyle: 'preserve-3d',
          }}
        >
          <div
            style={{
              width: cubeSize,
              height: cubeSize,
              transformStyle: 'preserve-3d',
              transition: draggingRef.current ? 'none' : 'transform 0.1s ease-out',
              transform: `scale(${visualScale}) rotateX(${tilt}deg) rotateY(${rotate}deg)`,
            }}
          >
            <div style={{ width: cubeSize, height: cubeSize, position: 'relative', transformStyle: 'preserve-3d' }}>
              {faces.map((face) => (
                <div
                  key={face.key}
                  className='absolute inset-0 flex items-center justify-center rounded-[8px] border border-border-default-base bg-background-default-base overflow-hidden'
                  style={{
                    transform: face.transform,
                  }}
                >
                  {imageSrc && face.key === 'front' ? (
                    <img
                      src={imageSrc}
                      alt=''
                      className='h-full w-full object-cover'
                      draggable={false}
                      style={{ pointerEvents: 'none' }}
                    />
                  ) : (
                    <span className='text-[14px] font-bold text-text-default-tertiary'>{face.label}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AngleCubeControl;
