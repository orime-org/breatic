// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The product analytics events and the properties each may carry.
 *
 * This list is the only gate between product data and the analytics vendor:
 * anything not named here is dropped before sending, so prompts, document
 * text, file names and email addresses cannot leave by accident (inner#1442
 * design §4.8, §4.10).
 */

type Kind = "string" | "number" | "boolean";

const SHARED = {
  app_version: "string",
  language: "string",
  membership_tier: "string",
  country: "string",
  success: "boolean",
} as const satisfies Record<string, Kind>;

const EVENT_PROPERTIES = {
  landing_viewed: { landing_page: "string" },
  pricing_viewed: { surface: "string" },
  signup_started: { method: "string" },
  signup_completed: { method: "string" },
  signup_failed: { method: "string", error_code: "string" },
  login_completed: { method: "string" },
  project_created: { studio_id: "string", project_id: "string", space_type: "string", via: "string", is_first: "boolean" },
  space_created: { studio_id: "string", project_id: "string", space_type: "string", via: "string" },
  first_agent_action_completed: { studio_id: "string", project_id: "string" },
  first_generation_completed: { studio_id: "string", project_id: "string", kind: "string" },
  member_invited: { studio_id: "string", project_id: "string", scope: "string", role: "string", invitation_id: "string" },
  invitation_accepted: { studio_id: "string", project_id: "string", scope: "string", role: "string", invitation_id: "string" },
  collaborator_first_action: { studio_id: "string", project_id: "string", action: "string" },
  active_project_session: { studio_id: "string", project_id: "string" },
  credit_purchase_completed: { credits: "number", amount_cents: "number", currency: "string" },
  credit_purchase_failed: { error_code: "string" },
  subscription_started: { tier: "string", amount_cents: "number", currency: "string", interval: "string" },
  subscription_renewed: { tier: "string", amount_cents: "number", currency: "string", interval: "string" },
  subscription_cancelled: { tier: "string", ends_at: "string" },
  refund_completed: { credits: "number", amount_cents: "number", currency: "string" },
} as const satisfies Record<string, Record<string, Kind>>;

/** Name of a product analytics event. */
export type AnalyticsEventName = keyof typeof EVENT_PROPERTIES;

/** Every event the product may send. */
export const ANALYTICS_EVENT_NAMES: readonly AnalyticsEventName[] = Object.freeze(
  Object.keys(EVENT_PROPERTIES) as AnalyticsEventName[],
);

/** Event property values after sanitizing. */
export type AnalyticsProperties = Record<string, string | number | boolean>;

const MAX_STRING_LENGTH = 200;

// Properties that hold a page address: only the path survives, so query
// strings (click IDs, session IDs, anything a link carried) never leave.
const PATH_ONLY: ReadonlySet<string> = new Set(["landing_page"]);

/**
 * Keep only the properties an event is allowed to carry.
 * @param name - The event.
 * @param properties - Candidate properties, from any caller.
 * @returns The listed properties whose values have the listed type, with
 *   strings cut to 200 characters and page addresses cut to their path; null
 *   when the event is not in the list.
 */
export function sanitizeEventProperties(
  name: AnalyticsEventName,
  properties: Record<string, unknown>,
): AnalyticsProperties | null {
  const own: Record<string, Kind> | undefined = Object.hasOwn(EVENT_PROPERTIES, name)
    ? EVENT_PROPERTIES[name]
    : undefined;
  if (!own) return null;
  const allowed: Record<string, Kind> = { ...SHARED, ...own };
  const out: AnalyticsProperties = {};
  for (const [key, kind] of Object.entries(allowed)) {
    const value = properties[key];
    if (typeof value !== kind) continue;
    if (typeof value === "string") {
      const text = PATH_ONLY.has(key) ? pathOf(value) : value;
      out[key] = text.slice(0, MAX_STRING_LENGTH);
    } else {
      out[key] = value as number | boolean;
    }
  }
  return out;
}

/**
 * The path part of an absolute or relative address.
 * @param address - A URL or a path, possibly with a query or fragment.
 * @returns The path alone.
 */
export function pathOf(address: string): string {
  try {
    return new URL(address, "https://placeholder.invalid").pathname;
  } catch {
    return "";
  }
}
