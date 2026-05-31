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
    // Default to a generic project so dispatch helpers that await
    // projectService.get(...).catch(() => null) don't blow up on
    // `.catch` of undefined (the vi.fn() default). Tests override
    // per-case when they need a specific project shape.
    get: vi.fn().mockResolvedValue({
      id: "p-1", name: "Test Project", description: null,
      createdByUserId: "u-1", studioId: "studio-1",
    }),
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
  // Balance repo (credit_balances table, PR3). The auth middleware now
  // resolves AuthUser.credits via creditRepo.getBalance, so EVERY authed
  // route touches this — without the mock, the real repo hits the empty
  // mock `db` and 500s the whole route suite.
  creditRepo: {
    getBalance: vi.fn().mockResolvedValue(100),
    deductBalance: vi.fn().mockResolvedValue(70),
    addBalance: vi.fn().mockResolvedValue(200),
    createBalanceRow: vi.fn().mockResolvedValue(undefined),
    recordTransaction: vi.fn().mockResolvedValue({ id: "tx-1" }),
    listTransactionsByUser: vi.fn().mockResolvedValue([]),
  },
  taskRepo: {
    getById: vi.fn(),
    markCompletedAndBill: vi.fn(),
  },
  nodeHistoryRepo: {
    listByNode: vi.fn().mockResolvedValue([]),
  },
  // Canvas node lock (moved to @breatic/domain in PR4). Defaults: lock
  // acquires cleanly + no prior holder so happy-path routes succeed.
  canvasLock: {
    CANVAS_LOCK_TTL_SECONDS: 7200,
    canvasNodeLockKey: vi.fn(),
    acquireCanvasNodeLock: vi.fn().mockResolvedValue(true),
    readCanvasNodeLockHolder: vi.fn().mockResolvedValue(null),
    verifyCanvasNodeLock: vi.fn().mockResolvedValue(true),
    releaseCanvasNodeLock: vi.fn().mockResolvedValue(undefined),
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
  projectMembersRepo: {
    getOwner: vi.fn().mockResolvedValue("u-owner"),
    getRole: vi.fn().mockResolvedValue("view"),
    listByProjectId: vi.fn().mockResolvedValue([]),
    updateRole: vi.fn().mockResolvedValue(true),
    upsertMember: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(true),
  },
  shareLinkService: {
    generateToken: vi.fn().mockReturnValue("token-mock"),
    createLink: vi.fn().mockResolvedValue({
      id: "sl-1", projectId: "p-1", createdByUserId: "u-owner",
      token: "token-mock", role: "view", kind: "link", boundEmail: null,
      consumedAt: null, expiresAt: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
    listByProject: vi.fn().mockResolvedValue([]),
    revokeLink: vi.fn().mockResolvedValue(undefined),
    consumeLink: vi.fn().mockResolvedValue({
      id: "sl-1", projectId: "p-1", createdByUserId: "u-owner",
      token: "token-mock", role: "view", kind: "link", boundEmail: null,
      consumedAt: new Date(), expiresAt: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }),
  },
  notificationService: {
    listUnread: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    countUnread: vi.fn().mockResolvedValue(0),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(0),
    createRoleUpgradeRequest: vi.fn().mockResolvedValue({
      id: "n-1", userId: "u-owner",
      type: "access.role_upgrade_request",
      payload: {}, projectId: "p-1",
      readAt: null, deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    }),
    createRoleUpgradeApproved: vi.fn().mockResolvedValue({}),
    createRoleUpgradeRejected: vi.fn().mockResolvedValue({}),
    createMemberJoined: vi.fn().mockResolvedValue({}),
  },
  notificationRepo: {
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    listUnreadByUser: vi.fn().mockResolvedValue([]),
    listAllByUser: vi.fn().mockResolvedValue([]),
    countUnread: vi.fn().mockResolvedValue(0),
    markRead: vi.fn().mockResolvedValue(false),
    markAllRead: vi.fn().mockResolvedValue(0),
  },
  roleUpgradeRequestService: {
    request: vi.fn().mockResolvedValue({
      id: "n-1", userId: "u-owner",
      type: "access.role_upgrade_request",
      payload: {}, projectId: "p-1",
      readAt: null, deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    }),
    approve: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
  },
  shareInviteMail: {
    buildShareInviteMail: vi.fn().mockReturnValue({
      to: "invitee@example.com", subject: "test", html: "<p>test</p>",
    }),
  },
  // sendMail spy lives in `mocks` so tests can mockRejectedValueOnce
  // to verify dispatch try/catch graceful degradation, and assert
  // call args via expect(mocks.sendMail).toHaveBeenCalledWith(...).
  sendMail: vi.fn().mockResolvedValue({
    status: "skipped",
    reason: "backend_disabled",
  } as { status: "skipped"; reason: "backend_disabled" }),
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
    // Infra-adjacent services that STAY in @breatic/core.
    uploadService: mocks.uploadService,
    publishMembersChanged: vi.fn().mockResolvedValue(undefined),
    // Shared authentication kernel (project_members repo + loadProjectRole
    // primitive — collab + server share these). AIGC business (credit /
    // task / node-history / agent / model-catalog / canvas-lock) moved to
    // @breatic/domain (PR4) — see domainMock below.
    projectMembersRepo: mocks.projectMembersRepo,
    projectAuthService: mocks.projectAuthService,
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

/**
 * Mock for `@breatic/domain` — the AIGC business kernel (credit / task /
 * node-history / agent / model-catalog / canvas-lock) extracted from
 * @breatic/core in PR4. Route tests that reach these pair it with
 * coreMock + serverModulesMock:
 *
 *   vi.mock("@breatic/core", coreMock);
 *   vi.mock("@breatic/domain", domainMock);
 *   vi.mock("@server/modules", serverModulesMock);
 *
 * Explicit (no importOriginal) so loading it never pulls the real agent
 * llm → `ai` SDK → otel ESM chain. Per-test overrides go through the
 * shared `mocks` refs (creditService / taskService / canvasLock / ...).
 */
export const domainMock = () => ({
  taskService: mocks.taskService,
  taskRepo: mocks.taskRepo,
  creditService: mocks.creditService,
  creditRepo: mocks.creditRepo,
  nodeHistoryService: mocks.nodeHistoryService,
  nodeHistoryRepo: mocks.nodeHistoryRepo,
  modelCatalog: { getModelCatalog: vi.fn().mockReturnValue({ image: [], video: [], audio: [] }) },
  listAvailableModels: vi.fn().mockReturnValue([]),
  getModel: vi.fn(),
  resolveProvider: vi.fn(),
  buildToolSet: vi.fn().mockReturnValue({}),
  DEFAULT_TOOLS: [],
  getSkillRegistry: () => ({
    get: (name: string) => name === "skill_creator" || name === "creative_research" ? { name, description: "...", tools: [] } : undefined,
    canUserInvoke: (name: string) => name !== "skill_creator",
  }),
  SkillRegistry: class {},
  loadAgents: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn().mockReturnValue([]),
  extractPromptText: vi.fn((s: string) => s),
  ...mocks.canvasLock,
});

/**
 * Mock for `@server/modules/user.repo.js` — the identity repo moved from
 * @breatic/core to @server in PR4. Tests that hit a route reading user
 * rows directly (canvas lock-holder lookup, batch /users) mock this path:
 *
 *   vi.mock("@server/modules/user.repo.js", userRepoMock);
 */
export const userRepoMock = () => mocks.userRepo;

/**
 * Mock for `@server/infra/mailer.js` — the mailer moved from @breatic/core
 * to @server in PR4. Tests that send mail mock this path.
 */
export const mailerMock = () => ({ sendMail: mocks.sendMail });

/**
 * Mock for `@server/modules` — the server-private domain (auth /
 * project / conversation / notification / share-link / ...) that moved
 * out of @breatic/core in the modular-monolith convergence (ADR 后端收敛
 * 为模块化单体). Route tests pair this with coreMock:
 *
 *   vi.mock("@breatic/core", coreMock);
 *   vi.mock("@server/modules", serverModulesMock);
 *
 * Per-test overrides still go through the same shared `mocks` refs.
 */
export const serverModulesMock = async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authService: mocks.authService,
    projectService: mocks.projectService,
    conversationService: mocks.conversationService,
    conversationRepo: mocks.conversationRepo,
    attachmentService: mocks.attachmentService,
    memoryService: mocks.memoryService,
    skillService: mocks.skillService,
    textToolService: mocks.textToolService,
    // projectAuthService + projectMembersRepo moved to @breatic/core
    // (auth-unification PR) — they now live in coreMock, not here.
    projectMembersService: mocks.projectMembersService,
    shareLinkService: mocks.shareLinkService,
    notificationService: mocks.notificationService,
    notificationRepo: mocks.notificationRepo,
    roleUpgradeRequestService: mocks.roleUpgradeRequestService,
    shareInviteMail: mocks.shareInviteMail,
    studioService: mocks.studioService,
    yjsDocRepo: mocks.yjsDocRepo,
  };
};
