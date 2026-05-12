import React, { memo, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, type TableColumn } from '@/ui/table';
import type { UserInfoType } from '@/app/store/userCenterStore';
import AccountTab from './AccountTab';
import Tabs from '@/ui/tabs';

interface ObtainedRecordDataItemType extends Record<string, unknown> {
  obtainedTime: string;
  typeDesc: string;
  quantity: number;
}

interface UsageRecordDataItemType extends Record<string, unknown> {
  usedToken: string;
  usedTime: string;
  typeDesc: string;
  creditsSource: string;
  quantity: number;
}

interface RechargeRecordItemType extends Record<string, unknown> {
  rechargeTime: string;
  typeDesc: string;
  totalAmount: string;
  orderNo: string;
  rechargeStatus: string;
  rechargeStatusDesc: string;
}

type TableDataItem = ObtainedRecordDataItemType | UsageRecordDataItemType | RechargeRecordItemType;

interface AccountProps {
  userInfo?: UserInfoType;
  onLogout?: () => void;
}

const Account: React.FC<AccountProps> = ({ userInfo, onLogout }) => {
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [data, setData] = useState<TableDataItem[]>([]);
  const { t } = useTranslation();

  // Build tab items with useMemo.
  const AccountTabsItems = useMemo(() => {
    const tableLoading = false;

    // Table columns.
    const getColumns = (tab: string): TableColumn<TableDataItem>[] => {
      if (tab === 'credits-obtained') {
        return [
          {
            title: t('userCenter.modal.account.tabs.creditsObtained.tHeader.date'),
            dataIndex: 'obtainedTime',
            key: 'obtainedTime',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{new Date(value as string).toLocaleString()}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.creditsObtained.tHeader.creditType'),
            dataIndex: 'typeDesc',
            key: 'typeDesc',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.creditsObtained.tHeader.creditsObtained'),
            dataIndex: 'quantity',
            key: 'quantity',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{Number(value).toLocaleString()}</span>,
          },
        ];
      } else if (tab === 'credits-used') {
        return [
          {
            title: t('userCenter.modal.account.tabs.creditsUsed.tHeader.date'),
            dataIndex: 'usedTime',
            key: 'usedTime',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{new Date(value as string).toLocaleString()}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.creditsUsed.tHeader.taskId'),
            dataIndex: 'usedToken',
            key: 'usedToken',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.creditsUsed.tHeader.taskName'),
            dataIndex: 'typeDesc',
            key: 'typeDesc',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.creditsUsed.tHeader.creditType'),
            dataIndex: 'creditsSource',
            key: 'creditsSource',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.creditsUsed.tHeader.creditsUsed'),
            dataIndex: 'quantity',
            key: 'quantity',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>-{value as number}</span>,
          },
        ];
      } else if (tab === 'billing') {
        return [
          {
            title: t('userCenter.modal.account.tabs.billing.tHeader.date'),
            dataIndex: 'rechargeTime',
            key: 'rechargeTime',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{new Date(value as string).toLocaleString()}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.billing.tHeader.serviceName'),
            dataIndex: 'typeDesc',
            key: 'typeDesc',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.billing.tHeader.paymentAmount'),
            dataIndex: 'totalAmount',
            key: 'totalAmount',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.billing.tHeader.orderNumber'),
            dataIndex: 'orderNo',
            key: 'orderNo',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
          {
            title: t('userCenter.modal.account.tabs.billing.tHeader.orderState'),
            dataIndex: 'rechargeStatusDesc',
            key: 'rechargeStatusDesc',
            align: 'left',
            render: (value: unknown) => <span className='text-text-default-secondary'>{value as string}</span>,
          },
        ];
      }
      return [];
    };

    return [
      {
        value: 'account',
        label: t('userCenter.modal.account.tabs.account.label'),
        content: <AccountTab userInfo={userInfo} onLogout={onLogout} />,
      },
      {
        value: 'credits-obtained',
        label: t('userCenter.modal.account.tabs.creditsObtained.label'),
        content: (
          <div className='max-h-[400px] overflow-y-auto'>
            <Table
              columns={getColumns('credits-obtained')}
              dataSource={data}
              loading={tableLoading}
              rowKey={(_, index) => `credits-obtained-${index}`}
              pagination={false}
              size='small'
            />
          </div>
        ),
      },
      {
        value: 'credits-used',
        label: t('userCenter.modal.account.tabs.creditsUsed.label'),
        content: (
          <div className='max-h-[400px] overflow-y-auto'>
            <Table
              columns={getColumns('credits-used')}
              dataSource={data}
              loading={tableLoading}
              rowKey={(_, index) => `credits-used-${index}`}
              pagination={false}
              size='small'
            />
          </div>
        ),
      },
      {
        value: 'billing',
        label: t('userCenter.modal.account.tabs.billing.label'),
        content: (
          <div className='max-h-[400px] overflow-y-auto'>
            <Table
              columns={getColumns('billing')}
              dataSource={data}
              loading={tableLoading}
              rowKey={(_, index) => `billing-${index}`}
              pagination={false}
              size='small'
            />
          </div>
        ),
      },
    ];
  }, [data, t, userInfo, onLogout]);

  // Table tabs: no HTTP — empty rows in local demo mode.
  const fetchTableData = (tab: string) => {
    if (tab === 'account') {
      setData([]);
      return;
    }
    setData([]);
  };

  // Handle tab switch.
  const handleTabChange = (index: number) => {
    setSelectedIndex(index);
    const tabValues = ['account', 'credits-obtained', 'credits-used', 'billing'];
    const tabValue = tabValues[index];
    fetchTableData(tabValue);
  };

  return (
    <div className='flex flex-col select-none'>
      <div className='flex flex-col items-center w-full px-[6px] py-[24px] gap-3 overflow-y-auto'>
        <Tabs
          items={AccountTabsItems}
          selectedIndex={selectedIndex}
          onChange={handleTabChange}
        />
      </div>
    </div>
  );
};

export default memo(Account);