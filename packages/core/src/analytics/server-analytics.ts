// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Product analytics from the backend (server, worker, collab).
 *
 * Off unless the deployment sets `AMPLITUDE_API_KEY`: a self-hosted instance
 * with no key never constructs a client and every call is a no-op (inner#1442
 * design §4.3). Each event is checked against the consent of the browser that
 * caused it and against the property whitelist before it leaves.
 */

import { createInstance } from "@amplitude/analytics-node";
import {
  sanitizeEventProperties,
  type AnalyticsEventName,
  type ConsentSnapshot,
} from "@breatic/shared";
import { currentConsent } from "@core/analytics/consent-context.js";

/** One event as the vendor receives it. */
export interface OutgoingEvent {
  readonly event_type: AnalyticsEventName;
  readonly user_id: string;
  readonly insert_id: string;
  readonly event_properties: Record<string, string | number | boolean>;
}

/** The slice of a vendor client the backend uses. */
export interface AnalyticsClient {
  track(event: OutgoingEvent): void;
  flush(): Promise<void>;
}

/** Result of starting analytics, for the service entry to log. */
export type ServerAnalyticsStart = "started" | "off" | "invalid";

// Amplitude project API keys are 32 hexadecimal characters.
const API_KEY = /^[0-9a-f]{32}$/i;
// Amplitude rejects user ids shorter than this (HTTP V2 `min_id_length`).
const MIN_USER_ID_LENGTH = 5;

let client: AnalyticsClient | null = null;

/**
 * Build the vendor client for a key.
 * @param apiKey - The Amplitude project key.
 * @param onError - Called when the vendor rejects a batch.
 * @returns A client bound to the US data center.
 */
function createAmplitudeClient(apiKey: string, onError: (message: string) => void): AnalyticsClient {
  const instance = createInstance();
  instance.init(apiKey, { serverZone: "US" });
  return {
    track(event) {
      void instance.track(event).promise.then((result) => {
        if (result.code >= 400) onError(`${String(result.code)} ${result.message}`);
      });
    },
    async flush() {
      await instance.flush().promise;
    },
  };
}

/**
 * Start backend analytics for this process.
 * @param options - Configuration from the service entry.
 * @param options.apiKey - `AMPLITUDE_API_KEY`; empty keeps analytics off.
 * @param options.onError - Called when the vendor rejects events; core cannot log.
 * @param options.createClient - Replaces the vendor client in tests.
 * @returns Whether analytics started, stayed off, or the key was malformed.
 */
export function initServerAnalytics(options: {
  apiKey: string;
  onError?: (message: string) => void;
  createClient?: (apiKey: string) => AnalyticsClient;
}): ServerAnalyticsStart {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") return "off";
  if (!API_KEY.test(apiKey)) return "invalid";
  const onError = options.onError ?? (() => undefined);
  client = options.createClient ? options.createClient(apiKey) : createAmplitudeClient(apiKey, onError);
  return "started";
}

/**
 * Send one product analytics event from the backend.
 * @param name - The event.
 * @param event - Who it is about and how to deduplicate it.
 * @param event.userId - The account id.
 * @param event.insertId - Stable id so a retried event counts once.
 * @param event.properties - Candidate properties; only whitelisted ones leave.
 * @param consent - The choice of the browser that caused the event; defaults
 *   to the current request's.
 */
export function trackServerEvent(
  name: AnalyticsEventName,
  event: { userId: string; insertId: string; properties: Record<string, unknown> },
  consent: ConsentSnapshot = currentConsent(),
): void {
  if (client === null || !consent.analytics) return;
  if (event.userId.length < MIN_USER_ID_LENGTH) return;
  const properties = sanitizeEventProperties(name, event.properties);
  if (properties === null) return;
  client.track({
    event_type: name,
    user_id: event.userId,
    insert_id: event.insertId,
    event_properties: properties,
  });
}

/** Send whatever is queued; called on shutdown. */
export async function flushServerAnalytics(): Promise<void> {
  await client?.flush();
}

/** Forget the client between tests. */
export function resetServerAnalyticsForTest(): void {
  client = null;
}
