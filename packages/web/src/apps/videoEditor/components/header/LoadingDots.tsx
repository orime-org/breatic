import React from 'react';

/* * * load component - display * * ： * - * - 0.2 sec * - 0.4 sec * - ， playback */
export const LoadingDots: React.FC = () => {
  return (
    <span className='inline-flex ml-1'>
      <span className='loading-dot'>.</span>
      <span className='loading-dot animation-delay-200'>.</span>
      <span className='loading-dot animation-delay-400'>.</span>
      <style>{`
        @keyframes dotFade {
          0%, 100% { opacity: 0; }
          50% { opacity: 1; }
        }
        .loading-dot {
          animation: dotFade 1.4s infinite;
          opacity: 0;
        }
        .animation-delay-200 {
          animation-delay: 0.2s;
        }
        .animation-delay-400 {
          animation-delay: 0.4s;
        }
      `}</style>
    </span>
  );
};

