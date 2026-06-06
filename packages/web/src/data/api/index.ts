// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * data/api barrel — single import surface for all REST clients.
 *
 * Stores / hooks should `import { projectsApi, membersApi } from '@web/data/api'`
 * rather than importing each file directly. Space lifecycle no longer
 * lives here — it moved to collab stateless RPC (see space-rpc-client).
 */

export { request, apiGet, apiPost, apiPatch, apiDelete } from '@web/data/api/request';
export { ApiException, type ApiError, type Pagination, type PageMeta } from '@web/data/api/types';

export { authApi, type AuthUser, type PersonalStudio } from '@web/data/api/auth';
export { usersApi, type UserSummary } from '@web/data/api/users';
export { projectsApi, type ProjectSummary, type ProjectDetail } from '@web/data/api/projects';
// spacesApi removed 2026-05-23: see ADR yjs-collab-only-write-authz.
// Space lifecycle (create / delete / lock / restore) now routes through
// `sendSpaceRpc` in `@/data/yjs/space-rpc-client`.
export { membersApi, type Member, type MemberRole } from '@web/data/api/members';
export { chatApi, type ChatStreamEvent, type ConversationSummary, type ConversationDetail } from '@web/data/api/chat';
export { canvasApi, type CanvasTask } from '@web/data/api/canvas';
export { miniToolsApi } from '@web/data/api/mini-tools';
export { textToolsApi, type TextStreamEvent } from '@web/data/api/text-tools';
export { tasksApi } from '@web/data/api/tasks';
export { skillsApi, type Skill } from '@web/data/api/skills';
export { paymentApi, type CreditTier, type PaymentRecord } from '@web/data/api/payment';
export { assetsApi, type PresignedUpload } from '@web/data/api/assets';
export { modelsApi, type ModelDef } from '@web/data/api/models';
