import React, { useRef } from 'react';
import { FloatButton } from '@/ui/floatButton';
import dayjs from 'dayjs';
import WorkspaceSider from './components/WorkspaceSider';
import UseCase from './components/UseCase';
import UserCenter from '@/apps/userCenter';
import ThemeSwitcher from './components/ThemeSwitcher';
import LanguageMap from './components/LanguageMap';
import RecentProjects, { RecentProjectsRef } from './components/RecentProjects';
import Login from './components/login';
import { Icon } from '@/ui/icon';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';

const Workspace: React.FC = () => {
  const { authInfo, authRequired } = useUserCenterStore();

  const currentYear = dayjs().year();
  const recentProjectsRef = useRef<RecentProjectsRef>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);

  // Check login gating.
  const isLoggedIn = authInfo?.state.isAuthenticated;
  const shouldShowLogin = authRequired && !isLoggedIn;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleScroll = (_values: any) => {
    const target = scrollbarRef.current;
    if (!target) return;

    const scrollTop = target.scrollTop;
    const scrollHeight = target.scrollHeight;
    const clientHeight = target.clientHeight;

    if (scrollHeight - scrollTop - clientHeight < 50) {
      if (recentProjectsRef.current) {
        const hasMore = recentProjectsRef.current.hasMore;
        const loading = recentProjectsRef.current.loading;
        if (hasMore && !loading) {
          recentProjectsRef.current.loadMore();
        }
      }
    }
  };

  const getScrollContainer = () => {
    return scrollbarRef.current || window;
  };

  return (
    <div className='w-full min-h-screen flex h-screen overflow-hidden'>
      <WorkspaceSider />
      <div className='flex-1 min-h-screen bg-background-default-base flex flex-col relative'>
        {shouldShowLogin ? (
          <Login />
        ) : (
          <>
            <div className='h-14 w-full flex flex-row justify-end items-center pr-14 gap-3'>
              <LanguageMap />
              <ThemeSwitcher />
              <UserCenter />
            </div>
            <div className='flex-1 flex flex-col px-[50px] min-h-0'>
              <div ref={scrollbarRef} className='flex-1 overflow-auto min-h-0' onScroll={handleScroll}>
                <UseCase />
                <RecentProjects ref={recentProjectsRef} />
              </div>
              <FloatButton.BackTop
                target={getScrollContainer}
                visibilityHeight={400}
                icon={<Icon name='workspace-arrow-warm-up' height={24} width={24} color='var(--color-icon-secondary)' />}
                offset={[10, 32]}
                className='w-6 h-8 min-w-6 p-1 rounded-full border-none bg-[var(--color-background-default-secondary)] [box-shadow:0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'
              />
              <div className='mx-auto py-2 flex flex-wrap flex-row justify-center mt-auto'>
                <p className='text-neutral-400 text-xs text-center'>
                  {`© ${currentYear} Orime. All Rights Reserved.`}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Workspace;
