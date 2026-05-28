/**
 * Shared @breatic/core mock for route-level tests.
 *
 * Call `vi.mock("@breatic/core", coreMock)` at the top of any test
 * file that exercises Hono routes. Provides fake db, redis, logger,
 * env, and service stubs. Individual tests can override specific
 * services via the returned mock references.
 *
 * Usage:
 *   import { coreMock, mocks } from "../helpers/mock-core.js";
 *   vi.mock("@breatic/core", coreMock);
 *   // then: mocks.projectService.assertAccess.mockRejectedValue(...)
 */

import { vi } from "vitest";

const mockPipeline = {
  zremrangebyscore: () => mockPipeline,
  zcard: () => mockPipeline,
  zadd: () => mockPipeline,
  expire: () => mockPipeline,
  exec: () => Promise.resolve([[null, 0], [null, 0], [null, 1], [null, 1]]),
};

const mockRedis = {
  ping: () => Promise.resolve("PONG"),
  on: () => mockRedis,
  get: (key: string) => {
    if (key.includes("session:valid-token")) return Promise.resolve("user-1");
    return Promise.resolve(null);
  },
  set: () => Promise.resolve("OK"),
  del: () => Promise.resolve(1),
  sadd: () => Promise.resolve(1),
  smembers: () => Promise.resolve([]),
  incr: () => Promise.resolve(1),
  expire: () => Promise.resolve(1),
  pipeline: () => mockPipeline,
};

/** Shared `queue.add` mock — reused across all `createQueue()` calls so tests can
 *  assert BullMQ job payloads without needing access to the queue instance. */
export const mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });

/**
 * Tracks `createQueue(name)` calls so tests can assert the queue name —
 * regression guard for a Phase 2 wiring bug where mini-tools.ts created
 * `"mini-tools"` queue but the worker only listens on `"tasks"`. Caught
 * in dev smoke test (PR #16); guarded by tests now.
 */
export const mockCreateQueue = vi.fn();

/** Mock references — tests can override behavior per-test. */
export const mocks = {
  authService: {
    register: vi.fn(),
    loginEmail: vi.fn(),
    loginOrCreateGoogle: vi.fn().mockResolvedValue({
      user: { id: "user-1", email: "u@x.com" },
      token: "sess-token",
    }),
    getUserByToken: vi.fn().mockResolvedValue({ id: "user-1", email: "u@x.com" }),
    logout: vi.fn(),
    // Default discriminant matches the post-17B auth.service contract
    // (anti-enumeration "unknown_email" branch returns no userId).
    forgotPassword: vi.fn().mockResolvedValue({ status: "unknown_email" }),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    resetPasswordWithRecoveryCode: vi.fn().mockResolvedValue({
      newRecoveryCode: "AAAA-BBBB-CCCC-DDDD",
      userId: "user-1",
    }),
    generateVerifyEmailToken: vi.fn(),
    verifyEmail: vi.fn().mockResolvedValue({ userId: "user-1" }),
    resendVerificationEmail: vi.fn().mockResolvedValue({
      mailResult: { status: "skipped", reason: "backend_disabled" },
    }),
  },
  projectService: {
    assertAccess: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    duplicate: vi.fn(),
    saveCanvas: vi.fn(),
    deleteProject: vi.fn(),
  },
  conversationService: {
    assertAccess: vi.fn().mockResolvedValue(undefined),
    getOrCreate: vi.fn().mockResolvedValue({ id: "conv-1", userId: "user-1" }),
    list: vi.fn(),
    getWithMessages: vi.fn(),
    deleteConversation: vi.fn(),
  },
  conversationRepo: {
    getConversation: vi.fn().mockResolvedValue({ id: "conv-1", lastConsolidatedTurn: 0 }),
    getMessagesForLlm: vi.fn().mockResolvedValue([]),
  },
  taskService: {
    create: vi.fn().mockResolvedValue({ id: "task-1", taskType: "image" }),
    setJobId: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    softDelete: vi.fn(),
  },
  nodeHistoryService: {
    listByNode: vi.fn(),
    recordGenerationSuccess: vi.fn(),
    recordGenerationFailure: vi.fn(),
    recordUpload: vi.fn(),
  },
  attachmentService: {
    listByConversation: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    softDelete: vi.fn(),
  },
  uploadService: {
    prepare: vi.fn().mockResolvedValue({ upload_id: "u1", upload_url: "http://x/u1", key: "k" }),
    loadTicket: vi.fn(),
    consumeTicket: vi.fn(),
  },
  memoryService: {
    buildContext: vi.fn().mockResolvedValue({ userMemory: "", projectMemory: "", conversationMemory: "" }),
  },
  userRepo: {
    getUserById: vi.fn().mockResolvedValue({ id: "user-1", email: "u@x.com" }),
    getUsersByIds: vi.fn().mockResolvedValue([]),
  },
  skillService: {
    listBuiltin: vi.fn().mockReturnValue([
      { name: "creative_research", description: "Research", scope: ["agent"] },
    ]),
    listUserSkills: vi.fn().mockResolvedValue([]),
  },
  textToolService: {
    execute: vi.fn(),
  },
  creditService: {
    deduct: vi.fn().mockResolvedValue(100),
    deductOnce: vi.fn().mockResolvedValue({ deducted: true, creditsAfter: 95 }),
    getBalance: vi.fn().mockResolvedValue(100),
    add: vi.fn().mockResolvedValue(200),
  },
  // v10: project-scoped permission lookup. Default = caller is owner
  // on every project. Tests that exercise non-owner / non-member
  // paths override per-test.
  projectAuthService: {
    loadProjectRole: vi.fn().mockResolvedValue("owner"),
  },
  projectMembersService: {
    list: vi.fn().mockResolvedValue([]),
    invite: vi.fn().mockResolvedValue(undefined),
    changeRole: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    getOwner: vi.fn().mockResolvedValue(null),
  },
  accessRequestService: {
    createRequest: vi.fn().mockResolvedValue({
      id: "ar-1", projectId: "p-1", requesterUserId: "u-1",
      requestedRole: "view", message: null, status: "pending",
      reviewedByUserId: null, reviewedAt: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
    listPendingByProject: vi.fn().mockResolvedValue([]),
    listByRequester: vi.fn().mockResolvedValue([]),
    approveRequest: vi.fn().mockResolvedValue({
      id: "ar-1", projectId: "p-1", requesterUserId: "u-1",
      requestedRole: "view", message: null, status: "approved",
      reviewedByUserId: "u-owner", reviewedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
    rejectRequest: vi.fn().mockResolvedValue({
      id: "ar-1", projectId: "p-1", requesterUserId: "u-1",
      requestedRole: "view", message: null, status: "rejected",
      reviewedByUserId: "u-owner", reviewedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
  },
  shareLinkService: {
    generateToken: vi.fn().mockReturnValue("token-mock"),
    createLink: vi.fn().mockResolvedValue({
      id: "sl-1", projectId: "p-1", createdByUserId: "u-owner",
      token: "token-mock", role: "view", isPermanent: false,
      consumedAt: null, expiresAt: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
    listByProject: vi.fn().mockResolvedValue([]),
    revokeLink: vi.fn().mockResolvedValue(undefined),
    consumeLink: vi.fn().mockResolvedValue({
      id: "sl-1", projectId: "p-1", createdByUserId: "u-owner",
      token: "token-mock", role: "view", isPermanent: false,
      consumedAt: new Date(), expiresAt: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
  },
  accessRequestMail: {
    buildAccessRequestCreatedMail: vi.fn().mockReturnValue({
      to: "owner@example.com", subject: "test", html: "<p>test</p>",
    }),
    buildAccessRequestApprovedMail: vi.fn().mockReturnValue({
      to: "req@example.com", subject: "test", html: "<p>test</p>",
    }),
    buildAccessRequestRejectedMail: vi.fn().mockReturnValue({
      to: "req@example.com", subject: "test", html: "<p>test</p>",
    }),
    buildShareInviteMail: vi.fn().mockReturnValue({
      to: "invitee@example.com", subject: "test", html: "<p>test</p>",
    }),
  },
  studioService: {
    ensurePersonalStudio: vi.fn().mockResolvedValue({
      id: "studio-1",
      ownerUserId: "user-1",
      name: "Personal Studio",
    }),
    getPersonalStudio: vi.fn().mockResolvedValue({
      id: "studio-1",
      ownerUserId: "user-1",
      name: "Personal Studio",
    }),
  },
  // members:changed pub/sub still lives here (the only control-plane
  // event the API still publishes — Space lifecycle moved to collab
  // stateless RPC per ADR 2026-05-23-yjs-collab-only-write-authz).
  yjsDocRepo: {
    softDeleteByName: vi.fn().mockResolvedValue(true),
  },
};

export const coreMock = async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Infra
    rawPg: Object.assign(
      (_s: TemplateStringsArray) => Promise.resolve([]),
      { end: () => Promise.resolve() },
    ),
    db: {},
    closeDb: () => Promise.resolve(),
    getRedis: () => mockRedis,
    closeRedis: () => Promise.resolve(),
    runMigrations: vi.fn(),
    createQueue: (name: string) => {
      mockCreateQueue(name);
      return { add: mockQueueAdd };
    },
    closeQueues: vi.fn(),
    defaultJobOpts: () => ({}),
    checkRateLimit: vi.fn().mockResolvedValue(true),
    publishNodeEvent: vi.fn(),
    getStorageAdapter: vi.fn(),
    setSession: vi.fn(),
    getSession: vi.fn(),
    // Config
    env: { ENV: "dev", PORT: 3000, ALLOWED_ORIGINS: "http://localhost:3001", COOKIE_DOMAIN: "", STORAGE_PROVIDER: "local", GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", PAYMENT_ENABLED: true, EMAIL_BACKEND: "disabled" },
    MONOREPO_ROOT: "/tmp",
    getAgentConfig: () => ({ default_model: "test", max_tool_iterations: 5, full_detail_turns: 3, memory_user_max_size: 1000, memory_project_max_size: 1000 }),
    // Logger
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
    // Services (namespace re-exports)
    authService: mocks.authService,
    projectService: mocks.projectService,
    conversationService: mocks.conversationService,
    conversationRepo: mocks.conversationRepo,
    taskService: mocks.taskService,
    nodeHistoryService: mocks.nodeHistoryService,
    attachmentService: mocks.attachmentService,
    uploadService: mocks.uploadService,
    memoryService: mocks.memoryService,
    userRepo: mocks.userRepo,
    skillService: mocks.skillService,
    textToolService: mocks.textToolService,
    modelCatalog: { getModelCatalog: vi.fn().mockReturnValue({ image: [], video: [], audio: [] }) },
    creditService: mocks.creditService,
    projectAuthService: mocks.projectAuthService,
    projectMembersService: mocks.projectMembersService,
    accessRequestService: mocks.accessRequestService,
    shareLinkService: mocks.shareLinkService,
    accessRequestMail: mocks.accessRequestMail,
    sendMail: vi.fn().mockResolvedValue({ status: "skipped", reason: "backend_disabled" }),
    studioService: mocks.studioService,
    publishMembersChanged: vi.fn().mockResolvedValue(undefined),
    yjsDocRepo: mocks.yjsDocRepo,
    // Agent
    getSkillRegistry: () => ({
      get: (name: string) => name === "skill_creator" || name === "creative_research" ? { name, description: "...", tools: [] } : undefined,
      canUserInvoke: (name: string) => name !== "skill_creator",
    }),
    runWithContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    // Errors (keep actual error classes)
    AppError: actual.AppError,
    NotFoundError: actual.NotFoundError,
    ForbiddenError: actual.ForbiddenError,
    ConflictError: actual.ConflictError,
    ValidationError: actual.ValidationError,
    UnauthorizedError: actual.UnauthorizedError,
  };
};
