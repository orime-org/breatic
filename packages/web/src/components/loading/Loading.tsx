import React from 'react';
import './Loading.css';

interface LoadingProps {
  /** Backdrop color (supports alpha) */
  backgroundColor?: string;
  /** Optional caption */
  text?: string;
  /** Container width; default full viewport */
  width?: string;
  /** Container height; default full viewport */
  height?: string;
  /** Relative overlay inside parent; default fixed fullscreen */
  inline?: boolean;
  /** Scale transform for the spinner block */
  scale?: number;
}

/** Full-screen or inline loading overlay */
const Loading: React.FC<LoadingProps> = ({
  backgroundColor = 'var(--color-shadow-overlay)',
  text,
  width = '100vw',
  height = '100vh',
  inline = false,
  scale,
}) => {
  return (
    <div
      className={inline ? 'loading-container loading-container--inline' : 'loading-container'}
      style={{
        width,
        height,
        background: backgroundColor,
      }}
    >
      <div
        className='loading-block'
        style={ scale !== undefined ? { transform: `scale(${scale}, ${scale})`, transformOrigin: 'center center' } : undefined }
      >
        <div className='breatic-loading css-breatic-loading'>
          <span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span>
        </div>
        <div className='breatic-loading2 css-breatic-loading'>
          <span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span>
        </div>
      </div>
      {text && (
        <div className='loading-text' style={{ marginTop: '100px' }}>
          {text}
        </div>
      )}
    </div>
  );
};

export default Loading;