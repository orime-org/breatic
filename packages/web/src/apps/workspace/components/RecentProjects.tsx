import React, { useEffect, useState, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { message } from '@/components/base/message';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import type { WorkspaceProject } from '../types';
import { projectsApi } from '@/apis';
import { Icon } from '@/components/base/icon';
import ConfirmModal from '@/components/modals/ConfirmModal';
import TextInputModal from '@/components/modals/TextInputModal';

export interface RecentProjectsRef {
  loadMore: () => void;
  hasMore: boolean;
  loading: boolean;
}

const PAGE_SIZE = 40;

/** Format an ISO timestamp as a short localized string for the card footer. */
function formatUpdateTime(value: string | Date): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}

type RecentProjectsProps = {
  /** Prepended rows for local/testing; not from the API. */
  staticProjects?: WorkspaceProject[];
};

const EMPTY_STATIC_PROJECTS: WorkspaceProject[] = [];

const RecentProjects = forwardRef<RecentProjectsRef, RecentProjectsProps>(({ staticProjects = EMPTY_STATIC_PROJECTS }, ref) => {
  const { t } = useTranslation();
  const [projectList, setProjectList] = useState<WorkspaceProject[]>([]);
  const [delModalOpen, setDelModalOpen] = useState<{ open: boolean; item: WorkspaceProject | null }>({ open: false, item: null });
  const [renameModalOpen, setRenameModalOpen] = useState<{ open: boolean; item: WorkspaceProject | null }>({ open: false, item: null });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const isInitRef = useRef(true);

  const fetchData = useCallback(async (isInit = false) => {
    if (loadingRef.current || (!isInit && !hasMoreRef.current)) return;

    setLoading(true);
    loadingRef.current = true;
    isInitRef.current = isInit;

    try {
      const offset = isInit ? 0 : offsetRef.current;
      const res = await projectsApi.list({ limit: PAGE_SIZE, offset });
      // `res.data` is already the response payload because `request.ts`'s
      // interceptor returns `response.data` (unwrapping the Axios envelope
      // at runtime). A second unwrap step here returns undefined for
      // arrays / primitive-shaped payloads and silently blanks the list.
      const records = res.data ?? [];

      if (isInit) {
        setProjectList([...staticProjects, ...records]);
        offsetRef.current = records.length;
      } else {
        setProjectList((prev) => [...prev, ...records]);
        offsetRef.current += records.length;
      }

      // No more pages when the backend returned fewer than we asked for.
      if (records.length < PAGE_SIZE) {
        hasMoreRef.current = false;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      message.error(errMsg);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [staticProjects]);

  const getSkeletonCount = () => {
    // On the initial load we have no idea how many rows are coming,
    // so show a full page's worth of shimmer cards. Subsequent pages
    // only need to fill the gap between what we have and the next
    // page boundary.
    if (isInitRef.current) {
      return PAGE_SIZE;
    }
    return PAGE_SIZE;
  };

  useImperativeHandle(
    ref,
    () => ({
      loadMore: () => {
        if (!loadingRef.current && hasMoreRef.current) {
          fetchData(false);
        }
      },
      get hasMore() {
        return hasMoreRef.current;
      },
      get loading() {
        return loadingRef.current;
      },
    }),
    [fetchData]
  );

  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  const deleteProject = async (item: WorkspaceProject) => {
    try {
      await projectsApi.remove(item.id);
      setProjectList((prev) => prev.filter((p) => p.id !== item.id));
      offsetRef.current = Math.max(0, offsetRef.current - 1);
      message.success(t('workspace.delete_success'));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      message.error(errMsg);
    } finally {
      setDelModalOpen({ open: false, item: null });
    }
  };

  const copyProject = async (item: WorkspaceProject) => {
    try {
      const res = await projectsApi.duplicate(item.id);
      const created = res.data;
      if (!created) {
        message.error(t('workspace.copy_failed'));
        return;
      }
      // Prepend the new card so the user sees the copy immediately.
      setProjectList((prev) => [created, ...prev]);
      offsetRef.current += 1;
      message.success(t('workspace.copy_success'));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      message.error(errMsg);
    }
  };

  const renameProject = async (item: WorkspaceProject, finalValue: string) => {
    const trimmed = finalValue.trim();
    if (!trimmed) {
      message.warning(t('workspace.project_name_required'));
      return;
    }

    try {
      const res = await projectsApi.update(item.id, { name: trimmed });
      const updated = res.data;
      if (updated) {
        setProjectList((prev) => prev.map((p) => (p.id === item.id ? updated : p)));
      }
      message.success(t('workspace.rename_success'));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      message.error(errMsg);
    } finally {
      setRenameModalOpen({ open: false, item: null });
    }
  };

  const handleMenuClick = (item: WorkspaceProject) => (key: string) => {
    switch (key) {
      case 'copy-project':
        copyProject(item);
        break;
      case 'rename-project':
        setRenameModalOpen({ open: true, item });
        break;
      case 'delete-project':
        setDelModalOpen({ open: true, item });
        break;
    }
  };

  const getMenuItems = (_item: WorkspaceProject): MenuItemType[] => {
    return [
      {
        key: 'copy-project',
        label: (
          <div className='flex items-center gap-1 p-1 text-xs font-bold text-text-default-base'>
            <Icon name='workspace-content-copy' width={24} height={24} color='var(--color-text-default-base)' />
            {t('workspace.copy_project')}
          </div>
        ),
      },
      {
        key: 'rename-project',
        label: (
          <div className='flex items-center gap-1 p-1 text-xs font-bold text-text-default-base'>
            <Icon name='workspace-content-edit' width={24} height={24} color='var(--color-text-default-base)' />
            {t('workspace.rename_project')}
          </div>
        ),
      },
      {
        key: 'delete-project',
        label: (
          <div className='flex items-center gap-1 p-1 text-xs font-bold text-[#EC221F]'>
            <Icon name='workspace-content-delete' width={24} height={24} color='#EC221F' />
            {t('workspace.delete_project')}
          </div>
        ),
      },
    ];
  };

  const handleProjectClick = (item: WorkspaceProject) => {
    window.location.href = `/project/${encodeURIComponent(item.id)}`;
  };

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

  return (
    <div className='mx-auto pb-16 min-w-[304px] max-w-full w-[304px] min-[788px]:w-[632px] min-[1116px]:w-[960px] min-[1444px]:w-[1288px] min-[1772px]:w-[1616px] min-[2100px]:w-[1944px]'>
      <div className='self-stretch justify-start text-text-default-base text-4xl font-medium leading-10 mb-6'>
        {t('workspace.recent_projects')}
      </div>
      <div className='flex flex-wrap gap-6 justify-start'>
        <div
          className='flex flex-col items-center justify-center h-[190px] w-[304px] max-w-full bg-background-default-base outline outline-1 hover:outline-2 outline-offset-[-1px] hover:outline-offset-[-2px] outline-border-utilities-brand rounded-lg shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] hover:shadow-[0px_4px_4px_-4px_rgba(12,12,13,0.05),0px_16px_32px_-4px_rgba(12,12,13,0.10),0px_0px_4px_-1px_rgba(12,12,13,0.05)] cursor-pointer transition-shadow'
          onClick={() => setCreateModalOpen(true)}
        >
          <div className='w-[38px] h-[38px] flex items-center justify-center mb-3'>
            <Icon name='workspace-vector' width={38} height={38} />
          </div>
          <span className='text-text-default-base text-sm font-bold leading-5'>{t('workspace.create_new_project')}</span>
        </div>
        {projectList.map((item) => {
          return (
            <div
              key={item.id}
              className='group flex flex-col w-[304px] max-w-full rounded-[8px] overflow-hidden shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] hover:shadow-[0px_4px_4px_-4px_rgba(12,12,13,0.05),0px_16px_32px_-4px_rgba(12,12,13,0.10),0px_0px_4px_-1px_rgba(12,12,13,0.05)] transition-shadow cursor-pointer'
              onClick={() => handleProjectClick(item)}
            >
              <div className='flex items-center justify-center relative overflow-hidden bg-background-default-base-hover rounded-t-[8px]' style={{ height: 146 }}>
                {item.thumbnailUrl ? (
                  <img
                    src={item.thumbnailUrl}
                    alt={item.name}
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
                    {item.name}
                  </p>
                  <p className='text-[9px] font-normal text-text-default-tertiary leading-3 line-clamp-1'>
                    {formatUpdateTime(item.updatedAt)}
                  </p>
                </div>
                <div
                  className='items-center justify-center w-6 h-6 opacity-0 group-hover:opacity-100'
                  onClick={(e) => e.stopPropagation()}
                >
                  <Dropdown
                    items={getMenuItems(item)}
                    onClick={handleMenuClick(item)}
                    trigger='hover'
                    placement='bottom-end'
                  >
                    <div className='cursor-pointer'>
                      <Icon name='workspace-more-vert' width={24} height={24} />
                    </div>
                  </Dropdown>
                </div>
              </div>
            </div>
          );
        })}
        {loading && (
          <>
            {Array.from({ length: getSkeletonCount() }).map((_, index) => (
              <div
                key={`skeleton-${index}`}
                className='w-[304px] h-[190px] max-w-full bg-background-default-secondary rounded-lg inline-flex flex-col justify-start items-start overflow-hidden'
              >
                <div className='self-stretch flex-1 relative bg-background-default-base-hover overflow-hidden'>
                  <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer'></div>
                </div>
                <div className='self-stretch pl-4 pr-1.5 py-1.5 inline-flex justify-center items-center'>
                  <div className='flex-1 h-8 inline-flex flex-col justify-start items-start gap-1'>
                    <div className='w-52 flex-1 bg-background-neutral-secondary rounded inline-flex justify-center items-center gap-2.5 relative overflow-hidden'>
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer' style={{ animationDelay: '0.05s' }}></div>
                    </div>
                    <div className='w-44 h-2.5 bg-background-neutral-secondary rounded inline-flex justify-center items-center gap-2.5 relative overflow-hidden'>
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer' style={{ animationDelay: '0.06s' }}></div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {!hasMoreRef.current && projectList.length > 0 && (
        <div className='w-full py-8 flex justify-center items-center'>
          <span className='text-neutral-400 text-sm'>{t('workspace.no_more_data')}</span>
        </div>
      )}

      {renameModalOpen.item && (
        <TextInputModal
          open={renameModalOpen.open}
          title={t('workspace.rename_project_title')}
          value={renameModalOpen.item.name}
          placeholder={t('workspace.rename_project_placeholder')}
          width={468}
          confirmText={t('workspace.btn_confirm')}
          cancelText={t('workspace.btn_cancel')}
          onCancel={() => setRenameModalOpen({ open: false, item: null })}
          onConfirm={(finalValue) => renameProject(renameModalOpen.item!, finalValue || '')}
        />
      )}

      {delModalOpen.item && (
        <ConfirmModal
          open={delModalOpen.open}
          title={
            <span className='text-text-default-base'>
              {t('workspace.delete_project_content_title')}
            </span>
          }
          description={t('workspace.delete_project_content_description')}
          confirmText={t('workspace.btn_confirm')}
          cancelText={t('workspace.btn_cancel')}
          onCancel={() => setDelModalOpen({ open: false, item: null })}
          onConfirm={() => deleteProject(delModalOpen.item!)}
        />
      )}

      <TextInputModal
        open={createModalOpen}
        title={t('workspace.create_project_title')}
        placeholder={t('workspace.create_project_placeholder')}
        confirmText={t('workspace.btn_confirm')}
        cancelText={t('workspace.btn_cancel')}
        onCancel={() => setCreateModalOpen(false)}
        onConfirm={(finalValue) => handleCreateProject(finalValue || '')}
      />
    </div>
  );
});

RecentProjects.displayName = 'RecentProjects';

export default RecentProjects;
