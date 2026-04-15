import React, { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';

/** Login prompt page for unauthenticated users. */
const Login: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const handleLogin = () => {
    navigate('/login');
  };
  return (
    <div className='w-full h-full flex flex-col items-center mt-[200px]'>
      <div className='mb-8'>
        <Icon name='project-leaf-icon' width={222} height={222} color='#D1D5DB' />
      </div>
      <div className='justify-start text-text-default-base text-4xl font-bold leading-10 mb-3'>
        {t('workspace.not_logged_in.title')}
      </div>
      <div className='justify-start text-text-default-base text-base font-light leading-6 tracking-wide mb-8'>
        {t('workspace.not_logged_in.description')}
      </div>
      <Button
        type='primary'
        size='large'
        shape='round'
        bordered={false}
        className='bg-[var(--color-brand-base)] hover:bg-[var(--color-brand-secondary)] text-white font-bold px-8 h-[36px]'
        onClick={handleLogin}
      >
        {t('workspace.not_logged_in.login_button')}
      </Button>
    </div>
  );
};

export default memo(Login);

