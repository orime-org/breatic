import React, { useEffect, memo, useState, useCallback } from 'react';
import Dialog from '@/ui/dialog';
import UpgradeButton from './components/UpgradeButton';
import InfoBadge from './components/InfoBadge';
import Purchase from './components/Purchase';
import Account from './components/Account';
import ConfirmModal from '@/app/shell/modals/ConfirmModal';
import { googleLogout } from '@react-oauth/google';
import { removeToken, getToken } from '@/data/api/token';
import { useTranslation } from 'react-i18next';
import type { UserInfoType } from '@/app/store/userCenterStore';
import { useUserCenterStore } from '@/app/hooks/useUserCenterStore';
import * as authApi from '@/data/api/auth';

const DEFAULT_USER_INFO: UserInfoType = {
  name: '',
  avatar: '',
  free_credits: 0,
  purchase_credits: 0,
  total_credits: 0,
  email: '',
};

interface UserCenterProps {
  className?: string;
  /** Hide InfoBadge when true. */
  hideInfoBadge?: boolean;
  /** Hide UpgradeButton title text when true. */
  hideUpgradeButtonText?: boolean;
}

const UserCenter: React.FC<UserCenterProps> = ({ className, hideInfoBadge = false, hideUpgradeButtonText = false }) => {
  const { userInfo, setUserInfo, authRequired } = useUserCenterStore();
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [purchaseCreditsModalOpen, setPurchaseCreditsModalOpen] = useState(false);
  const [logoutModalOpen, setLogoutModalOpen] = useState(false);
  const { t } = useTranslation();

  // Convert store userInfo to component shape (empty object -> undefined).
  const displayUserInfo = userInfo && Object.keys(userInfo).length > 0 ? userInfo : undefined;

  const fetchUserInfo = useCallback(async () => {
    const tokenStr = getToken();
    const authInfo = tokenStr ? JSON.parse(tokenStr as string) : null;
    if (!authInfo?.state?.token) {
      setUserInfo(DEFAULT_USER_INFO);
      return;
    }
    try {
      const res = await authApi.getMe();
      const user = res.data;
      setUserInfo({
        name: user.username || user.email.split('@')[0],
        avatar: user.avatarUrl || '',
        // Breatic is credits-only — no plan/tier. `total_credits` is the
        // single balance number; the two sub-buckets exist for display
        // (how much came from free grants vs paid purchases) but don't
        // gate any feature. The backend's /auth/me currently returns one
        // merged `credits` number, so both buckets read from it until a
        // future endpoint splits them.
        free_credits: user.credits,
        purchase_credits: 0,
        total_credits: user.credits,
        email: user.email,
      });
    } catch {
      setUserInfo(DEFAULT_USER_INFO);
    }
  }, [setUserInfo]);

  /** Strip Stripe-style query params without calling the server. */
  const handlePaymentCallback = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('credits_result')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  useEffect(() => {
    fetchUserInfo();
    handlePaymentCallback();
  }, [fetchUserInfo]);

  // Handle user logout.
  const handleUserLogout = async () => {
    googleLogout();
    removeToken();

    window.location.href = '/workspace';
  };

  if (!authRequired) return null;

  return (
    <>
      <div className={`bg-transparent z-20 flex items-center gap-4 ${className || ''}`}>
        <UpgradeButton
          userInfo={displayUserInfo}
          onPurchaseClick={() => setPurchaseCreditsModalOpen(true)}
          hideTitleText={hideUpgradeButtonText}
        />
        {!hideInfoBadge && (
          <InfoBadge
            userInfo={displayUserInfo}
            onAccountClick={() => setAccountModalOpen(true)}
            onLogoutClick={() => setLogoutModalOpen(true)}
            onUpgradeClick={() => setPurchaseCreditsModalOpen(true)}
          />
        )}
      </div>

      <Dialog
        show={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        width={783}
        className='account-management-modal'
      >
        <Account userInfo={displayUserInfo} onLogout={() => setLogoutModalOpen(true)} />
      </Dialog>

      <Dialog
        show={purchaseCreditsModalOpen}
        onClose={() => setPurchaseCreditsModalOpen(false)}
        width={665}
        className='purchase-modal'
      >
        <Purchase />
      </Dialog>

      {/* Logout confirmation modal */}
      <ConfirmModal
        open={logoutModalOpen}
        title={<>{t('userCenter.modal.logout.title')}</>}
        description={t('userCenter.modal.logout.description')}
        confirmText={t('userCenter.modal.logout.confirm')}
        cancelText={t('userCenter.modal.logout.cancel')}
        onCancel={() => setLogoutModalOpen(false)}
        onConfirm={handleUserLogout}
      />
    </>
  );
};

export default memo(UserCenter);
