// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Module barrel — shared auth kernel only.
 *
 * Everything else moved out: server-private domain → `@server`/src/modules
 * (modular-monolith convergence ADR); AIGC business shared by
 * server+worker (credit / task / node-history) → `@breatic/domain`
 * (domain-extraction ADR); user.repo / stripe / mailer / pricing →
 * `@server` (PR4). What remains is the project_members repo + the
 * loadProjectRole auth primitive, shared by server (requireRole) and
 * collab (onAuthenticate).
 */

export * as projectMembersRepo from "@core/auth/projectMembers.repo.js";
export * as projectAuthService from "@core/auth/projectAuth.service.js";
