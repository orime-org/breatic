// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";

const miniToolRuns = new Hono<{ Variables: AuthVariables }>();
miniToolRuns.use(requireAuth);
miniToolRuns.get("/:runId", () => { throw new Error("Planned execution route is not implemented"); });
export { miniToolRuns as miniToolRunsRoute };
