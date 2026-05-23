/**
 * data/api barrel — single import surface for all REST clients.
 *
 * Stores / hooks should `import { projectsApi, membersApi } from '@/data/api'`
 * rather than importing each file directly. Space lifecycle no longer
 * lives here — it moved to collab stateless RPC (see space-rpc-client).
 */

export { request, apiGet, apiPost, apiPatch, apiDelete } from './request';
export { ApiException, type ApiError, type Pagination, type PageMeta } from './types';

export { authApi, type AuthUser } from './auth';
export { usersApi, type UserSummary } from './users';
export { projectsApi, type ProjectSummary, type ProjectDetail } from './projects';
// spacesApi removed 2026-05-23: see ADR yjs-collab-only-write-authz.
// Space lifecycle (create / delete / lock / restore) now routes through
// `sendSpaceRpc` in `@/data/yjs/space-rpc-client`.
export { membersApi, type Member, type MemberRole } from './members';
export { chatApi, type ChatStreamEvent, type ConversationSummary, type ConversationDetail } from './chat';
export { canvasApi, type CanvasTask } from './canvas';
export { miniToolsApi } from './mini-tools';
export { textToolsApi, type TextStreamEvent } from './text-tools';
export { tasksApi } from './tasks';
export { skillsApi, type Skill } from './skills';
export { paymentApi, type CreditTier, type PaymentRecord } from './payment';
export { assetsApi, type PresignedUpload } from './assets';
export { modelsApi, type ModelDef } from './models';
