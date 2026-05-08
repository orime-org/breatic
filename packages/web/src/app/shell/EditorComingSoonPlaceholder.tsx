import React from 'react';
import { useTranslation } from 'react-i18next';

type EditorComingSoonPlaceholderProps = {
  nodeId: string;
};

/**
 * Placeholder rendered in place of the deleted MixedEditor for image/video/audio nodes
 * until the dedicated per-media editors land in a future PR.
 */
const EditorComingSoonPlaceholder: React.FC<EditorComingSoonPlaceholderProps> = () => {
  const { t } = useTranslation();
  return (
    <div className='flex h-full w-full flex-col items-center justify-center gap-3 bg-background-default-secondary text-text-default-tertiary'>
      <span className='text-sm'>{t('editor.comingSoon', 'Editor coming soon')}</span>
    </div>
  );
};

export default EditorComingSoonPlaceholder;
