/**
 * @server module barrel — server-private domain (service + repo).
 *
 * These moved out of @breatic/core in the modular-monolith convergence
 * (ADR 后端收敛为模块化单体): only server uses them. core keeps the
 * SHARED services (credit / task / node-history) + infra + schema.
 * Routes / middleware import the domain via this barrel.
 */

export * as authService from "@server/modules/auth.service.js";
export * as recoveryCodeService from "@server/modules/recovery-code.service.js";
export * as conversationService from "@server/modules/conversation.service.js";
export * as conversationRepo from "@server/modules/conversation.repo.js";
export * as attachmentService from "@server/modules/conversation-attachment.service.js";
export * as attachmentRepo from "@server/modules/conversation-attachment.repo.js";
export * as memoryService from "@server/modules/memory.service.js";
export * as memoryRepo from "@server/modules/memory.repo.js";
export * as paymentService from "@server/modules/payment.service.js";
export * as paymentRepo from "@server/modules/payment.repo.js";
export * as projectService from "@server/modules/project.service.js";
export * as projectRepo from "@server/modules/project.repo.js";
export * as yjsDocRepo from "@server/modules/yjs-doc.repo.js";
export * as projectMembersService from "@server/modules/projectMembers.service.js";
export * as roleUpgradeRequestService from "@server/modules/roleUpgradeRequest.service.js";
export * as notificationService from "@server/modules/notification.service.js";
export * as notificationRepo from "@server/modules/notification.repo.js";
export * as shareLinkService from "@server/modules/shareLink.service.js";
export * as shareLinkRepo from "@server/modules/shareLink.repo.js";
export * as shareInviteMail from "@server/modules/share-invite-mail.js";
export * as skillService from "@server/modules/skill.service.js";
export * as skillRepo from "@server/modules/skill.repo.js";
export * as studioService from "@server/modules/studio.service.js";
export * as studioRepo from "@server/modules/studio.repo.js";
export * as textToolService from "@server/modules/text-tool.service.js";
