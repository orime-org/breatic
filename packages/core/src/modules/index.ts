/**
 * Module barrel export.
 *
 * Re-exports the SHARED repositories and services that stay in core
 * (used by 2+ of server / worker). Server-private domain moved to
 * @server/src/modules — see ADR 后端收敛为模块化单体.
 */

export * as userRepo from "@core/modules/user.repo.js";
export * as creditRepo from "@core/modules/credit.repo.js";
export * as creditService from "@core/modules/credit.service.js";
export * as taskRepo from "@core/modules/task.repo.js";
export * as taskService from "@core/modules/task.service.js";
export * as nodeHistoryRepo from "@core/modules/node-history.repo.js";
export * as nodeHistoryService from "@core/modules/node-history.service.js";
