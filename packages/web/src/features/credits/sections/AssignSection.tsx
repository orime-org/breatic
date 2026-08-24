// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditLotView } from '@breatic/shared';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { designateCreditLot, fetchCreditLots } from '@web/data/api/credits';
import { studiosApi } from '@web/data/api/studios';
import {
  Card,
  ListEnd,
  Notice,
  Row,
  Rows,
  Section,
  Footnote,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  formatMoney,
} from '@web/features/credits/section-chrome';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';
import { toast } from '@web/lib/toast';

/** Whose purchases, and whether billing is on at all. */
interface AssignSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** Whether this deployment charges for generation at all. */
  billing: boolean;
}

/** The value the picker carries when a purchase points at no studio. */
const NONE = 'none';

/**
 * Point purchases at the studios that will spend them.
 *
 * Only `active` purchases are listed. One in a refund is detached from every
 * studio the moment it is asked for and may not be pointed anywhere, and a
 * spent one has nothing left to move — in neither case is there a decision to
 * make here.
 * @param props - The account and whether billing is on.
 * @param props.userId - The signed-in account, for the query key.
 * @param props.billing - Whether this deployment charges at all.
 * @returns The section.
 */
export function AssignSection({
  userId,
  billing,
}: AssignSectionProps): React.JSX.Element {
  const t = useTranslation();
  const read = React.useCallback(
    (cursor: string | undefined) =>
      fetchCreditLots({
        lifecycle: 'active',
        ...(cursor === undefined ? {} : { cursor }),
      }),
    [],
  );
  const paging = useCreditsPaging<CreditLotView>({
    queryKey: ['credits', 'lots', userId, 'active'],
    read,
    enabled: billing && userId !== null,
  });

  // Only studios this account administers: pointing credits at a studio is an
  // admin's decision about that studio's budget, and the server refuses it
  // from anybody else. Offering the rest would be offering a rejection.
  const studios = useQuery({
    queryKey: ['studios', 'mine', userId],
    queryFn: () => studiosApi.listUserStudios(),
    enabled: billing && userId !== null,
  });
  const admins = React.useMemo(
    () =>
      (studios.data ?? []).filter((studio) => studio.myStudioRole === 'admin'),
    [studios.data],
  );

  return (
    <Section title={t('credits.section.assign')}>
      {!billing ? (
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      ) : paging.isPending || studios.isPending ? (
        // Both reads, because a row cannot be drawn without either. With only
        // the purchases in hand every picker is built from an empty list of
        // studios, which reads as "you no longer administer this one" on the
        // assigned rows and leaves the rest with nowhere to point.
        <SectionSkeleton />
      ) : paging.isError || studios.isError ? (
        // Either read failing leaves this section unable to do its one job:
        // without the purchases there is nothing to point, and without the
        // studios there is nowhere to point it.
        <SectionError />
      ) : paging.rows.length === 0 ? (
        <>
          <SectionEmpty message={t('credits.assignEmpty')} />
          <Notice
            title={t('credits.assignEmptyNotice.title')}
            body={t('credits.assignEmptyNotice.body')}
          />
        </>
      ) : (
        <>
          <Card>
            <Rows>
              {paging.rows.map((lot) => (
                <AssignRow
                  key={lot.id}
                  lot={lot}
                  studios={admins}
                  userId={userId}
                />
              ))}
            </Rows>
          </Card>
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
            failed={paging.pageFailed}
          />
          <Footnote>{t('credits.assignNote')}</Footnote>
        </>
      )}
    </Section>
  );
}

/** One purchase, and where it may be pointed. */
interface AssignRowProps {
  /** The purchase. */
  lot: CreditLotView;
  /** The studios this account administers. */
  studios: { id: string; name: string }[];
  /** The signed-in account, for invalidating its reads. */
  userId: string | null;
}

/**
 * One purchase, with a picker for the studio that may spend it.
 * @param props - The purchase, the studios, and the account.
 * @param props.lot - The purchase.
 * @param props.studios - The studios this account administers.
 * @param props.userId - The signed-in account.
 * @returns The row.
 */
function AssignRow({
  lot,
  studios,
  userId,
}: AssignRowProps): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const current =
    lot.designatedStudioId !== null &&
    lot.designatedStudioName !== null &&
    !studios.some((studio) => studio.id === lot.designatedStudioId)
      ? { id: lot.designatedStudioId, name: lot.designatedStudioName }
      : null;

  const designate = useMutation({
    mutationFn: (studioId: string | null) =>
      designateCreditLot(lot.id, studioId),
    onSuccess: () => {
      // Every read of this account's money moves at once: the purchase changed
      // hands, so the studio it left and the one it joined both have a
      // different balance than a moment ago, and pointing it at a studio that
      // owed writes a repayment into the ledger.
      void client.invalidateQueries({ queryKey: ['credits', 'lots', userId] });
      void client.invalidateQueries({
        queryKey: ['credits', 'overview', userId],
      });
      void client.invalidateQueries({
        queryKey: ['credits', 'ledger', userId],
      });
    },
    onError: () => {
      toast.error(t('credits.designateFailed'));
    },
  });

  /**
   * Point this purchase at the chosen studio, or take it back.
   * @param value - The studio's id, or the sentinel meaning none.
   */
  const handleChange = (value: string): void => {
    designate.mutate(value === NONE ? null : value);
  };

  return (
    <Row
      main={`${formatMoney(lot.paidCents, lot.currency)} · ${formatLocalDay(lot.createdAt)}`}
      sub={t('credits.remaining', {
        amount: formatCreditAmount(lot.remainingCredits),
      })}
      right={
        <Select
          value={lot.designatedStudioId ?? NONE}
          onValueChange={handleChange}
          disabled={designate.isPending}
        >
          <SelectTrigger
            className='h-7 w-auto gap-2 text-sm'
            aria-label={t('credits.designationFor', {
              amount: formatMoney(lot.paidCents, lot.currency),
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('credits.unassigned')}</SelectItem>
            {/* Where it points now, when that is somewhere this account can no
                longer choose — after being demoted in that studio, say. The
                options answer "where may this go"; the trigger reports where
                it is, and with no item to match, Radix shows nothing at all.
                It is offered unselectable: leaving is allowed, returning is
                not. */}
            {current === null ? null : (
              <SelectItem value={current.id} disabled>
                {current.name}
              </SelectItem>
            )}
            {studios.map((studio) => (
              <SelectItem key={studio.id} value={studio.id}>
                {studio.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}
