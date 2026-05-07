import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { message } from '@/ui/message';
import { UseCaseItemObjType } from '@/apps/userCenter/types';
import { projectsApi } from '@/data/api';
import { Icon } from '@/ui/icon';
import TextInputModal from '@/components/modals/TextInputModal';

/** Static carousel row (replaces `/api/workflow/use_case/query`). */
const STATIC_USE_CASES: UseCaseItemObjType[] = [
  {
    id: 'static-use-case-1',
    use_case_name: 'Canvas starter',
    use_case_version: '1',
    use_case_desc: 'Demo template — click the card, name a project, and open the editor locally.',
    content: null,
    use_case_screen: null,
  },
];

const UseCase: React.FC = () => {
  const { t } = useTranslation();
  const [useCaseList] = useState<UseCaseItemObjType[]>(STATIC_USE_CASES);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isBeginning, setIsBeginning] = useState(true);
  const [isEnd, setIsEnd] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleCreateProject = async (finalValue: string) => {
    const trimmed = finalValue.trim();
    if (!trimmed) {
      message.warning(t('workspace.project_name_required'));
      return;
    }

    setCreateModalOpen(false);

    try {
      const res = await projectsApi.create({ name: trimmed });
      const created = res.data;
      if (!created) {
        message.error(t('workspace.create_failed'));
        return;
      }
      window.location.href = `/project/${encodeURIComponent(created.id)}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      message.error(errMsg);
    }
  };

  const handleUseCaseClick = () => {
    setCreateModalOpen(true);
  };

  const handlePrev = () => {
    if (scrollContainerRef.current) {
      const scrollAmount = 304 + 24;
      scrollContainerRef.current.scrollBy({
        left: -scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  const handleNext = () => {
    if (scrollContainerRef.current) {
      const scrollAmount = 304 + 24;
      scrollContainerRef.current.scrollBy({
        left: scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  const updateNavigationState = () => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
      setIsBeginning(scrollLeft <= 0);
      setIsEnd(scrollLeft >= scrollWidth - clientWidth - 1);
    }
  };

  return (
    <div className='mx-auto pb-16 min-w-[304px] max-w-full w-[304px] min-[788px]:w-[632px] min-[1116px]:w-[960px] min-[1444px]:w-[1288px] min-[1772px]:w-[1616px] min-[2100px]:w-[1944px]'>
      <div className='flex items-center justify-between text-4xl font-medium leading-10 mb-6 gap-2'>
        <div className='self-stretch justify-start text-text-default-base'>{t('workspace.use_case')}</div>
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className='w-7 h-7 p-[2px] flex-shrink-0 flex items-center justify-center rounded-full bg-background-default-secondary'
        >
          {isCollapsed ? (
            <Icon name='workspace-fold-content' height={24} width={24} color='var(--color-icon-secondary)' />
          ) : (
            <Icon name='workspace-unfold-content' height={24} width={24} color='var(--color-icon-secondary)' />
          )}
        </button>
      </div>

      {!isCollapsed && (
        <div className='text-sm font-normal text-text-default-secondary leading-5 mb-6'>
          {t('workspace.use_case_description')}
        </div>
      )}

      {!isCollapsed && (
        <>
          <div
            ref={scrollContainerRef}
            className='flex flex-nowrap gap-6 justify-start overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] [-ms-overflow-style:none]'
            onScroll={updateNavigationState}
          >
            {useCaseList.map((item) => (
              <div
                key={item.id}
                className='group flex flex-col w-[304px] flex-shrink-0 rounded-[8px] overflow-hidden shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] hover:shadow-[0px_4px_4px_-4px_rgba(12,12,13,0.05),0px_16px_32px_-4px_rgba(12,12,13,0.10),0px_0px_4px_-1px_rgba(12,12,13,0.05)] transition-shadow cursor-pointer'
                onClick={handleUseCaseClick}
              >
                <div className='flex items-center justify-center relative overflow-hidden bg-background-default-base-hover rounded-t-[8px]' style={{ height: 146 }}>
                  {item.use_case_screen ? (
                    <img
                      src={item.use_case_screen}
                      alt={item.use_case_name}
                      className='w-full h-full object-cover transition-transform duration-300 ease-in-out group-hover:scale-110'
                    />
                  ) : (
                    <div className='w-36 h-28 flex items-center justify-center transition-transform duration-300 ease-in-out group-hover:scale-110'>
                      <Icon
                        name='workspace-logo'
                        width={144}
                        height={112}
                        color='var(--color-background-default-base)'
                      />
                    </div>
                  )}
                </div>
                <div className='pl-4 pr-[6px] flex justify-between items-center py-[6px] bg-background-default-secondary'>
                  <div className='flex flex-col justify-center'>
                    <p className='text-sm font-bold leading-5 text-text-default-base truncate w-[210px]'>
                      {item.use_case_name}
                    </p>
                    <p className='text-[9px] font-normal text-text-default-secondary leading-3 line-clamp-1'>
                      {item.use_case_desc}
                    </p>
                  </div>
                  <div className='items-center justify-center w-6 h-6 hidden group-hover:block'>
                    <Icon name='workspace-next-page' width={24} height={24} color='var(--color-icon-secondary)' />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {useCaseList.length > 0 && (
            <div className='flex items-center justify-between mt-6'>
              <button
                onClick={handlePrev}
                disabled={isBeginning}
                className='w-7 h-7 p-[2px] flex items-center justify-center rounded-full bg-background-default-secondary disabled:opacity-40 disabled:cursor-not-allowed'
              >
                <Icon name='workspace-last-page' height={24} width={24} color='var(--color-icon-secondary)' />
              </button>
              <button
                onClick={handleNext}
                disabled={isEnd}
                className='w-7 h-7 p-[2px] flex items-center justify-center rounded-full bg-background-default-secondary disabled:opacity-40 disabled:cursor-not-allowed'
              >
                <Icon name='workspace-next-page' height={24} width={24} color='var(--color-icon-secondary)' />
              </button>
            </div>
          )}
        </>
      )}

      <TextInputModal
        open={createModalOpen}
        title={t('workspace.create_user_case_title')}
        description={t('workspace.create_user_case_description')}
        placeholder={t('workspace.create_user_case_placeholder')}
        width={468}
        confirmText={t('workspace.btn_confirm')}
        cancelText={t('workspace.btn_cancel')}
        onCancel={() => setCreateModalOpen(false)}
        onConfirm={(finalValue) => handleCreateProject(finalValue || '')}
      />
    </div>
  );
};

export default UseCase;

