// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The internal API's authorisation table (inner#1410 §4.3, §4.5): every
 * route the back office and the billing service may call, by method and
 * path. Anything else falls to the app's `notFound`, which answers 403.
 */

import type { Hono } from "hono";
import "@server/middleware/internal-auth.js";
import { registerMaintenanceRoutes } from "@server/routes/internal/maintenance.js";
import { registerCreditGrantRoutes } from "@server/routes/internal/credit-grant.js";
import { registerEnterpriseCreditPurchaseRoutes } from "@server/routes/internal/enterprise-credit-purchase.js";
import { registerEnterpriseMembershipRoutes } from "@server/routes/internal/enterprise-membership.js";
import { registerDeploymentVersionRoute } from "@server/routes/internal/deployment-version.js";
import { registerCommerceRoutes } from "@server/routes/internal/commerce.js";
import { registerInfluencerRoutes } from "@server/routes/internal/influencer.js";

/**
 * Register the table on the internal app.
 * @param app - The internal app, after its rate limit and authentication.
 */
export function registerInternalRoutes(app: Hono): void {
  registerEnterpriseMembershipRoutes(app);
  registerCreditGrantRoutes(app);
  registerEnterpriseCreditPurchaseRoutes(app);
  registerMaintenanceRoutes(app);
  registerDeploymentVersionRoute(app);
  registerCommerceRoutes(app);
  registerInfluencerRoutes(app);
}
