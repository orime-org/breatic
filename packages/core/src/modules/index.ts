/**
 * Module barrel export.
 *
 * Server-private domain moved to @server/src/modules (modular-monolith
 * convergence ADR). AIGC business shared by server+worker (credit /
 * task / node-history) moved to @breatic/domain (domain-extraction
 * ADR). Only the shared identity repo stays here.
 */

export * as userRepo from "@core/modules/user.repo.js";
