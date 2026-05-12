/**
 * ProjectTitle — editable project name in the TopBar left cluster
 * (mock 05 @1101). Inline input, commits on blur or Enter; falls
 * back to the previous value if the user types empty + blurs.
 *
 * Carries the autosave timestamp below the name when present —
 * extracted from the old `ProjectHeader.tsx` so the metadata stays
 * adjacent to the title it describes.
 */
import { memo, useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectInfo } from '@/app/store/projectInfoStore';

export interface ProjectTitleProps {
  projectName: string;
  onCommit: (next: string) => void;
}

/** Format an autosave timestamp as HH:MM. */
function formatAutosaveTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

const ProjectTitle: React.FC<ProjectTitleProps> = memo(function ProjectTitle({
  projectName,
  onCommit,
}) {
  const { t } = useTranslation();
  const autosaveTime = useProjectInfo((s) => s.autosaveTime);
  const [inputValue, setInputValue] = useState<string>(projectName);

  // Sync from prop — parent may rename the project from elsewhere
  // (drawer, system message, etc.) and we want this input to track.
  useEffect(() => {
    setInputValue(projectName);
  }, [projectName]);

  const handleBlur = () => {
    const next = inputValue.trim();
    if (!next) {
      setInputValue(projectName);
      return;
    }
    if (next !== projectName) {
      onCommit(next);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setInputValue(projectName);
      e.currentTarget.blur();
    }
  };

  return (
    <div className="flex min-w-0 flex-col">
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="min-w-0 w-full text-[13px] text-text-default-base font-semibold leading-5 bg-transparent border-none outline-none p-0 m-0 truncate"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        aria-label={t('project.header.titleAria', { defaultValue: 'Project title' })}
      />
      {autosaveTime > 0 && (
        <div className="text-[10px] text-text-default-tertiary leading-3">
          {t('project.header.autosavedAt')} {formatAutosaveTime(autosaveTime)}
        </div>
      )}
    </div>
  );
});

export default ProjectTitle;
