/**
 * data/api barrel — single import surface for all REST clients.
 *
 * Stores / hooks should `import { projectsApi, membersApi } from '@/data/api'`
 * rather than importing each file directly. Space lifecycle no longer
 * lives here — it moved to collab stateless RPC (see space-rpc-client).
 */

export { request, apiGet, apiPost, apiPatch, apiDelete } from '@/data/api/request';
export { ApiException, type ApiError, type Pagination, type PageMeta } from '@/data/api/types';

export { authApi, type AuthUser } from '@/data/api/auth';
export { usersApi, type UserSummary } from '@/data/api/users';
export { projectsApi, type ProjectSummary, type ProjectDetail } from '@/data/api/projects';
// spacesApi removed 2026-05-23: see ADR yjs-collab-only-write-authz.
// Space lifecycle (create / delete / lock / restore) now routes through
// `sendSpaceRpc` in `@/data/yjs/space-rpc-client`.
export { membersApi, type Member, type MemberRole } from '@/data/api/members';
export { chatApi, type ChatStreamEvent, type ConversationSummary, type ConversationDetail } from '@/data/api/chat';
export { canvasApi, type CanvasTask } from '@/data/api/canvas';
export { miniToolsApi } from '@/data/api/mini-tools';
export { textToolsApi, type TextStreamEvent } from '@/data/api/text-tools';
export { tasksApi } from '@/data/api/tasks';
export { skillsApi, type Skill } from '@/data/api/skills';
export { paymentApi, type CreditTier, type PaymentRecord } from '@/data/api/payment';
export { assetsApi, type PresignedUpload } from '@/data/api/assets';
export { modelsApi, type ModelDef } from '@/data/api/models';
