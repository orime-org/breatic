// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { StripeWebhookResult } from "@breatic/shared";

export interface WebhookIdentity {
  eventId: string;
  eventType: string;
  livemode: boolean;
  connectedAccountId: string | null;
}

export interface AttemptStart extends WebhookIdentity {
  id: string;
  accountId: string | null;
  endpointId: string | null;
  environment: string;
  receivedAt: Date;
}

export interface AttemptCompletion {
  id: string;
  responseStatus: number;
  result: StripeWebhookResult;
}

export type CompletionState = "recorded" | "already_finished";

export interface WebhookDispatch {
  result: StripeWebhookResult;
  responseStatus: 200 | 500;
  received: boolean;
}
