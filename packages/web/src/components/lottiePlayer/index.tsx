import React, { useEffect, useRef } from 'react';
import lottie, { AnimationItem } from 'lottie-web';

interface LottiePlayerProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  animationData: any;
  className?: string;
  style?: React.CSSProperties;
  playOnHover?: boolean;
  playOnLeave?: boolean;
}

const LottiePlayer = ({
  animationData,
  className,
  style,
  playOnHover = false,
  playOnLeave = false,
}: LottiePlayerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<AnimationItem | null>(null);
  const isPlayingRef = useRef(false);
  const directionRef = useRef<1 | -1>(1);

  useEffect(() => {
    if (!containerRef.current) return;

    const animation = lottie.loadAnimation({
      container: containerRef.current,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      animationData,
    });

    animationRef.current = animation;

    const handleComplete = () => {
      isPlayingRef.current = false;
      if (directionRef.current === -1) {
        animation.goToAndStop(0, true);
      }
    };

    animation.addEventListener('complete', handleComplete);

    return () => {
      animation.removeEventListener('complete', handleComplete);
      animation.destroy();
      animationRef.current = null;
      isPlayingRef.current = false;
    };
  }, [animationData]);

  const handleMouseEnter = () => {
    if (!playOnHover) return;
    if (isPlayingRef.current) return;

    const animation = animationRef.current;
    if (!animation) return;

    directionRef.current = 1;
    isPlayingRef.current = true;

    animation.setDirection(1);
    animation.goToAndPlay(0, true);
  };

  const handleMouseLeave = () => {
    if (!playOnLeave) return;

    const animation = animationRef.current;
    if (!animation) return;

    const currentFrame = animation.currentFrame; // snapshot before setDirection(-1)

    animation.setDirection(-1);
    animation.setSpeed(1);

    isPlayingRef.current = true;
    animation.goToAndPlay(currentFrame, true);
  };

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: 'transparent',
        ...style,
      }}
    />
  );
};

export default LottiePlayer;
