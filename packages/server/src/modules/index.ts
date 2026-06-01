/**
 * @server module barrel - server-private domain (service + repo).
 *
 * These moved out of @breatic/core in the modular-monolith convergence
 * (ADR backend convergence to a modular monolith): only server uses them. core keeps the
 * SHARED services (credit / task / node-history) + infra + schema.
 * Routes / middleware import the domain via this barrel.
 */

export * as authService from "@server/modules/auth/auth.service.js";
export * as recoveryCodeService from "@server/modules/auth/recovery-code.service.js";
export * as conversationService from "@server/modules/conversation/conversation.service.js";
export * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
export * as attachmentService from "@server/modules/conversation/conversation-attachment.service.js";
export * as attachmentRepo from "@server/modules/conversation/conversation-attachment.repo.js";
export * as memoryService from "@server/modules/memory/memory.service.js";
export * as memoryRepo from "@server/modules/memory/memory.repo.js";
export * as paymentService from "@server/modules/payment/payment.service.js";
export * as paymentRepo from "@server/modules/payment/payment.repo.js";
export * as projectService from "@server/modules/project/project.service.js";
export * as projectRepo from "@server/modules/project/project.repo.js";
export * as yjsDocRepo from "@server/modules/yjs-doc/yjs-doc.repo.js";
export * as projectMembersService from "@server/modules/project/projectMembers.service.js";
export * as roleUpgradeRequestService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
export * as notificationService from "@server/modules/notification/notification.service.js";
export * as notificationRepo from "@server/modules/notification/notification.repo.js";
export * as shareLinkService from "@server/modules/share/shareLink.service.js";
export * as shareLinkRepo from "@server/modules/share/shareLink.repo.js";
export * as shareInviteMail from "@server/modules/share/share-invite-mail.js";
export * as skillService from "@server/modules/skill/skill.service.js";
export * as skillRepo from "@server/modules/skill/skill.repo.js";
export * as studioService from "@server/modules/studio/studio.service.js";
export * as studioRepo from "@server/modules/studio/studio.repo.js";
export * as textToolService from "@server/modules/text-tool/text-tool.service.js";
