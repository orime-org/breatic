// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Events the billing service reports through the product (inner#1993 §3.3
 * `conversions`): renewals, cancellations and failed payments, which no
 * product transaction carries. Analytics and the ad queue each dedupe on
 * their own id; the stored answer keeps a repeat from reaching them at all.
 * Nothing is reported for an account that does not exist or was deleted.
 */

import {
  accountOnlyConsent,
  enqueueAdsConversion,
  fingerprint,
  serverAnalyticsWanted,
  trackServerEvent,
  type ConversionReport,
} from "@breatic/core";
import { getUserById } from "@server/modules/auth/user.repo.js";
import { answerOnce } from "@server/modules/commerce/commerce-request.service.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";

const ROUTE = "/internal/v1/commerce/conversions";

/**
 * Report one event once per insert id.
 * @param report - The event and, when it counts toward one, its ad conversion.
 * @returns 200 `{ tracked, adsQueued }`; 404 `account_not_found` for an account that does not exist or was deleted; 422 for a reused insert id.
 * @throws {Error} When the database or the ad queue cannot be reached; nothing is stored, so a retry reports again.
 */
export async function reportConversion(report: ConversionReport): Promise<StoredAnswer> {
  return answerOnce(
    { key: `conv:${report.insertId}`, kind: "conv", hash: fingerprint("POST", ROUTE, report.insertId, report) },
    async (tx) => {
      if ((await getUserById(report.userId, tx)) === null) {
        return { status: "refused", httpStatus: 404, body: { code: "account_not_found" } };
      }
      const { consent: reported } = report;
      const account = reported === "account";
      const consent = account ? await accountOnlyConsent(report.userId) : reported;
      trackServerEvent(report.name, { userId: report.userId, insertId: report.insertId, properties: report.properties }, consent);
      const { ads } = report;
      const adsQueued =
        ads !== null &&
        (await enqueueAdsConversion(
          {
            userId: report.userId,
            conversion: ads.conversion,
            transactionId: ads.transactionId,
            click: ads.click,
            ...(ads.value === null ? {} : { value: ads.value }),
          },
          account ? null : { consent: consent.ads },
        ));
      return { status: "applied", httpStatus: 200, body: { tracked: serverAnalyticsWanted(consent), adsQueued } };
    },
  );
}
