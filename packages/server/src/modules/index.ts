// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `@server` module barrel - server-private domain SERVICES only.
 *
 * These moved out of `@breatic/core` in the modular-monolith convergence
 * (ADR backend convergence to a modular monolith): only server uses them. core keeps the
 * SHARED services (credit / task / node-history) + infra + schema.
 *
 * Routes / middleware import the domain via this barrel and MUST go
 * through services — repos are module-internal (prohibition #1: routes
 * never touch the data layer). The `*.repo.js` files are reached only
 * by their owning module via deep imports, never re-exported here.
 */

export * as membershipService from "@server/modules/account/membership.service.js";
export * as enterpriseMembershipService from "@server/modules/enterprise-membership/enterprise-membership.service.js";
export * as assetUploadService from "@server/modules/asset/assetUpload.service.js";
export * as assetUsageService from "@server/modules/asset/assetUsage.service.js";
export * as pasteAssetsService from "@server/modules/asset/pasteAssets.service.js";
export * as sceneTasksService from "@server/modules/asset/scene-tasks.service.js";
export * as sceneGenerationService from "@server/modules/asset/scene-generation.service.js";
export { holdRun } from "@server/modules/task/generation-task.js";
export * as transferReferenceService from "@server/modules/asset/transfer-reference.service.js";
export * as authService from "@server/modules/auth/auth.service.js";
export * as desktopHandoffService from "@server/modules/auth/desktop-handoff.service.js";
export * as invitationService from "@server/modules/invitation/invitation.service.js";
export * as recoveryCodeService from "@server/modules/auth/recovery-code.service.js";
export * as signupCodeService from "@server/modules/auth/signup-code.service.js";
export * as conversationService from "@server/modules/conversation/conversation.service.js";
export * as attachmentService from "@server/modules/conversation/conversation-attachment.service.js";
export * as agentInstructionsService from "@server/modules/conversation/agent-instructions.service.js";
export * as runningTurnsService from "@server/modules/conversation/running-turns.service.js";
export * as memoryService from "@server/modules/memory/memory.service.js";
export { precheckAgentTurn, precheckCredits, reserveForRun } from "@server/modules/credit/credit-precheck.service.js";
export * as creditViewService from "@server/modules/credit/credit-view.service.js";
export {
  assertStorageAllowance,
  assertStudioStorageAllowance,
} from "@server/modules/asset/storageQuota.service.js";
export * as projectService from "@server/modules/project/project.service.js";
export * as projectMembersService from "@server/modules/project/projectMembers.service.js";
export * as recentService from "@server/modules/recent/recent.service.js";
export * as roleUpgradeRequestService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
export * as projectJoinRequestService from "@server/modules/project-join-request/projectJoinRequest.service.js";
export * as notificationService from "@server/modules/notification/notification.service.js";
export * as studioService from "@server/modules/studio/studio.service.js";
export * as textToolService from "@server/modules/text-tool/text-tool.service.js";
export * as webAnimationExecutionService from "@server/modules/web-animation/web-animation-execution.service.js";
export * as documentVersionService from "@server/modules/document-version/document-version.service.js";

export * as maintenanceService from "@server/modules/maintenance/maintenance.service.js";

export * as creditGrantService from "@server/modules/credit-grant/credit-grant.service.js";

export * as byokService from "@server/modules/byok/byok.service.js";
export * as enterpriseCreditPurchaseService from "@server/modules/enterprise-credit-purchase/enterprise-credit-purchase.service.js";
