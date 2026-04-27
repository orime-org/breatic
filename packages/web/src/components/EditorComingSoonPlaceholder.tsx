import React from 'react';

type EditorComingSoonPlaceholderProps = {
  nodeId: string;
};

/**
 * Placeholder rendered in place of the deleted MixedEditor for image/video/audio nodes
 * until the dedicated per-media editors land in a future PR.
 */
const EditorComingSoonPlaceholder: React.FC<EditorComingSoonPlaceholderProps> = () => {
  return (
    <div className='flex h-full w-full flex-col items-center justify-center gap-3 bg-background-default-secondary text-text-default-tertiary'>
      <span className='text-sm'>Editor coming soon</span>
    </div>
  );
};

export default EditorComingSoonPlaceholder;
