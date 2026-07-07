// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

export * as assetUploadService from "@server/modules/asset/assetUpload.service.js";
export * as authService from "@server/modules/auth/auth.service.js";
export * as recoveryCodeService from "@server/modules/auth/recovery-code.service.js";
export * as conversationService from "@server/modules/conversation/conversation.service.js";
export * as attachmentService from "@server/modules/conversation/conversation-attachment.service.js";
export * as memoryService from "@server/modules/memory/memory.service.js";
export * as paymentService from "@server/modules/payment/payment.service.js";
export { precheckCredits } from "@server/modules/payment/credit-precheck.service.js";
export * as projectService from "@server/modules/project/project.service.js";
export * as projectMembersService from "@server/modules/project/projectMembers.service.js";
export * as recentService from "@server/modules/recent/recent.service.js";
export * as roleUpgradeRequestService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
export * as notificationService from "@server/modules/notification/notification.service.js";
export * as skillService from "@server/modules/skill/skill.service.js";
export * as studioService from "@server/modules/studio/studio.service.js";
export * as textToolService from "@server/modules/text-tool/text-tool.service.js";
