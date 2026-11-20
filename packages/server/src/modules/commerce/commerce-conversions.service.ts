// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Events the billing service reports through the product (inner#1993 §3.3
 * `conversions`): renewals, cancellations and failed payments, which no
 * product transaction carries. Analytics and the ad queue each dedupe on
 * their own id; the stored answer keeps a repeat from reaching them at all.
 */

import {
  accountOnlyConsent,
  enqueueAdsConversion,
  fingerprint,
  serverAnalyticsWanted,
  trackServerEvent,
  type ConversionReport,
} from "@breatic/core";
import { answerOnce } from "@server/modules/commerce/commerce-request.service.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";

const ROUTE = "/internal/v1/commerce/conversions";

/**
 * Report one event once per insert id.
 * @param report - The event and, when it counts toward one, its ad conversion.
 * @returns 200 `{ tracked, adsQueued }`, or 422 for a reused insert id.
 * @throws {Error} When the database or the ad queue cannot be reached; nothing is stored, so a retry reports again.
 */
export async function reportConversion(report: ConversionReport): Promise<StoredAnswer> {
  return answerOnce(
    { key: `conv:${report.insertId}`, kind: "conv", hash: fingerprint("POST", ROUTE, report.insertId, report) },
    async () => {
      const account = report.consent === "account";
      const consent = report.consent === "account" ? await accountOnlyConsent(report.userId) : report.consent;
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
