import React, { useEffect, memo, useState, useCallback } from 'react';
import Dialog from '@/components/base/dialog';
import UpgradeButton from './components/UpgradeButton';
import InfoBadge from './components/InfoBadge';
import Upgrade from './components/Upgrade';
import Purchase from './components/Purchase';
import Account from './components/Account';
import ConfirmModal from '@/components/modals/ConfirmModal';
import { googleLogout } from '@react-oauth/google';
import { removeToken, getToken } from '@/utils/token';
import { useTranslation } from 'react-i18next';
import { UserInfoType } from '@/store/modules/userCenter';
import { PlanItemType } from './types';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import * as authApi from '@/apis/auth';

const DEFAULT_USER_INFO: UserInfoType = {
  name: '',
  avatar: '',
  planId: 1,
  planName: 'Free',
  free_credits: 0,
  membership_credits: 0,
  purchase_credits: 0,
  total_credits: 0,
  email: '',
};

/** Static membership cards (replaces `/api/plan/list`). */
const DEMO_PLANS: PlanItemType[] = [
  {
    id: 1,
    name: 'Free',
    cycle: 'MONTHLY',
    description: 'Local demo',
    features: ['Canvas editing', 'No server billing'],
    featuresExt: [],
    icon: '',
    price: '0',
    strikePrice: '',
  },
  {
    id: 2,
    name: 'Pro',
    cycle: 'MONTHLY',
    description: 'Demo tier',
    features: ['Higher limits', 'Export'],
    featuresExt: [],
    icon: '',
    price: '9.99',
    strikePrice: '14.99',
  },
  {
    id: 3,
    name: 'Team',
    cycle: 'MONTHLY',
    description: 'Demo team',
    features: ['Collaboration'],
    featuresExt: [],
    icon: '',
    price: '29.00',
    strikePrice: '',
  },
  {
    id: 11,
    name: 'Free',
    cycle: 'ANNUAL',
    description: 'Local demo',
    features: ['Canvas editing', 'No server billing'],
    featuresExt: [],
    icon: '',
    price: '0',
    strikePrice: '',
  },
  {
    id: 12,
    name: 'Pro',
    cycle: 'ANNUAL',
    description: 'Demo tier',
    features: ['Higher limits', 'Export'],
    featuresExt: [],
    icon: '',
    price: '99.00',
    strikePrice: '129.00',
  },
  {
    id: 13,
    name: 'Team',
    cycle: 'ANNUAL',
    description: 'Demo team',
    features: ['Collaboration'],
    featuresExt: [],
    icon: '',
    price: '290.00',
    strikePrice: '',
  },
];

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
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [purchaseCreditsModalOpen, setPurchaseCreditsModalOpen] = useState(false);
  const [logoutModalOpen, setLogoutModalOpen] = useState(false);
  const [membershipPlanList, setMembershipPlanList] = useState<PlanItemType[]>([]);
  const { t } = useTranslation();

  // Convert store userInfo to component shape (empty object -> undefined).
  const displayUserInfo = userInfo && Object.keys(userInfo).length > 0 ? userInfo : undefined;

  const fetchUserInfo = useCallback(async () => {
    const tokenStr = getToken();
    const authInfo = tokenStr ? JSON.parse(tokenStr as string) : null;
    if (!authInfo?.state?.token) {
      setUserInfo(DEFAULT_USER_INFO);
      setMembershipPlanList(DEMO_PLANS);
      return;
    }
    try {
      const res = await authApi.getMe();
      const user = res.data;
      setUserInfo({
        name: user.username || user.email.split('@')[0],
        avatar: user.avatarUrl || '',
        planId: 1,
        planName: user.membershipType === 'free' ? 'Free' : 'Pro',
        free_credits: user.credits,
        membership_credits: 0,
        purchase_credits: 0,
        total_credits: user.credits,
        email: user.email,
      });
    } catch {
      setUserInfo(DEFAULT_USER_INFO);
    }
    setMembershipPlanList(DEMO_PLANS);
  }, [setUserInfo]);

  /** Strip Stripe-style query params without calling the server. */
  const handlePaymentCallback = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('subscription_result') || params.has('credits_result')) {
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
          onUpgradeClick={() => setUpgradeModalOpen(true)}
          onPurchaseClick={() => setPurchaseCreditsModalOpen(true)}
          hideTitleText={hideUpgradeButtonText}
        />
        {!hideInfoBadge && (
          <InfoBadge
            userInfo={displayUserInfo}
            onAccountClick={() => setAccountModalOpen(true)}
            onLogoutClick={() => setLogoutModalOpen(true)}
            onUpgradeClick={() => setUpgradeModalOpen(true)}
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
        show={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        width={665}
        className='upgrade-modal'
      >
        <Upgrade membershipPlanList={membershipPlanList} />
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
