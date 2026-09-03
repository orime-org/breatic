// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
// The real names, read from the one file that holds them. A relative path
// because this stub must not pull the domain barrel (and the `ai` SDK behind
// it); test code is exempt from the alias rule.
import { TOOLS_THAT_BLOCK as REAL_TOOLS_THAT_BLOCK } from "../../../../domain/src/agent/tools/blocking-tools.js";
import { STOPPED_BY_USER as REAL_STOPPED_BY_USER } from "../../../../domain/src/agent/tools/failure.js";

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
  /**
   * core's real AppError, stashed by coreMock.
   *
   * domainMock is synchronous and importOriginal-free, so it cannot reach
   * the class itself — and the error handler identifies errors by
   * `instanceof`, so a look-alike with the same `.status` comes back a 500.
   */
  appError: Error as unknown as new (status: number, message: string) => Error,
  authService: {
    register: vi.fn(),
    loginEmail: vi.fn(),
    loginOrCreateGoogle: vi.fn().mockResolvedValue({
      user: { id: "user-1", email: "u@x.com" },
      token: "sess-token",
    }),
    getUserByToken: vi.fn().mockResolvedValue({ id: "user-1", email: "u@x.com" }),
    // Thin pass-throughs to the user repo (prohibition #1: routes call
    // the service, not the repo). Aliased to the `userRepo` spies below
    // (see the assignment after the `mocks` literal) so a single
    // `mocks.userRepo.getUserById.mockResolvedValue(...)` drives the
    // route path that now goes through `authService.getUserById`.
    getUserById: vi.fn().mockResolvedValue({ id: "user-1", email: "u@x.com" }),
    getUsersByIds: vi.fn().mockResolvedValue([]),
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
    list: vi.fn(),
    getWithMessages: vi.fn(),
    deleteConversation: vi.fn(),
    createConversation: vi.fn(),
    rename: vi.fn(),
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
  // #1675 server execute gate (i2i/edit needs a source image). Default: no
  // violation — existing task-create tests stay green; the #1675 test flips it.
  violatesSourceRequirementForModel: vi.fn().mockReturnValue(false),
  // #1735 server reference-count gate (too many reference images). Default: no
  // violation (null) — existing tests stay green; the #1735 test flips it.
  violatesReferenceCountForModel: vi.fn().mockReturnValue(null),
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
    buildContext: vi.fn().mockResolvedValue({ projectMemory: "", conversationMemory: "" }),
  },
  // User identity read fns. Routes reach these through `authService`
  // (prohibition #1 — routes call services, not repos); the auth service
  // is a thin pass-through to user.repo. We expose the SAME spy refs on
  // both `userRepo` (used by auth.service unit tests that mock the repo
  // directly) and `authService.getUserById` / `getUsersByIds` (used by
  // route tests) so a single `mockResolvedValue` drives both boundaries.
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
  // The lot engine (#11). Its shape follows the real module: the two reads
  // answer in credits, and a charge reports what it took and what it could
  // not. A route suite that leaves these unmocked reaches the real queries
  // against the empty mock `db` and 500s.
  creditLotService: {
    // Read at module evaluation by `routes/schemas.ts`, so a double without it
    // hands zod an undefined pattern: the schema still builds, and the first
    // request carrying the header dies inside the check rather than being
    // refused at the door.
    REFKEY_PATTERN: /^[A-Za-z0-9_:.-]{1,255}$/,
    getSpendableCredits: vi.fn().mockResolvedValue(100),
    getStudioDebt: vi.fn().mockResolvedValue(0),
    getOverview: vi.fn().mockResolvedValue({
      assignedCredits: 0,
      unassignedCredits: 0,
      studios: [],
    }),
    getUnassignedCredits: vi.fn().mockResolvedValue(0),
    chargeForGeneration: vi.fn().mockResolvedValue({
      billed: true,
      charged: 5,
      shortfall: 0,
      studioId: "s0000000-0000-4000-8000-000000000001",
      lotIds: ["l0000000-0000-4000-8000-000000000001"],
    }),
    chargeOnceForGeneration: vi.fn().mockResolvedValue({
      billed: true,
      charged: 5,
      shortfall: 0,
      studioId: "s0000000-0000-4000-8000-000000000001",
      lotIds: ["l0000000-0000-4000-8000-000000000001"],
    }),
    grantFromPayment: vi.fn(),
    designateLot: vi.fn(),
  },
  taskRepo: {
    getById: vi.fn(),
    markCompletedAndBill: vi.fn(),
  },
  nodeHistoryRepo: {
    listByNode: vi.fn().mockResolvedValue([]),
  },
  // Stream publish (task-events). Shared ref so route tests can drive
  // publish failures (#1580 adversarial: the handling-OPEN is a hard
  // prerequisite of the gen echo chain, not best-effort).
  publishNodeEvent: vi.fn().mockResolvedValue(undefined),
  // Storage adapter (local / S3 / OSS). Exposed on `mocks` so route tests can
  // configure head() / publicUrl() per-test (e.g. the #1824 cover wire); default
  // unconfigured (resolves undefined) — only happy-path upload tests set it.
  getStorageAdapter: vi.fn(),
  // Upload dedup service (#1609). The real one hits assetService.resolveOwnerStudioId
  // + DB, so override it — route tests that exercise the dedup /uploaded path
  // (incl. the #1824 dedup-cover decoupling) configure verifyDedupUpload per-test.
  /**
   * The storage gate (#89). Answers with room by default — a route test that
   * did not set it up is not asking about storage, and a gate that refused by
   * default would make every such test fail for a reason it never named.
   */
  assertStorageAllowance: vi.fn(async () => undefined),
  assetUploadService: {
    checkUploadDedup: vi.fn(),
    verifyDedupUpload: vi.fn(),
    // #1826 upload-grant anti-spoof: presign issues a grant, the upload
    // endpoints authorise (write-time) + consume (registration terminal).
    issueUploadGrant: vi.fn(),
    authorizeUploadWrite: vi.fn(),
    consumeUploadGrant: vi.fn(),
    // Reads the AUTHORITATIVE owner studio off the grant (#1826 §2.2 v15) —
    // /uploaded attributes the asset to it instead of re-deriving one from the
    // client-supplied project_id.
    resolveGrantForReport: vi.fn(),
  },
  // Domain asset registry (@breatic/domain). The /uploaded regular path calls
  // register() to write the studio_assets row; route tests that exercise
  // node-bound fail-closed / canonical-pin (#1826 §0 rule 3 / 铁律 2) set its
  // resolve / reject per-test.
  assetService: {
    register: vi.fn(),
    // The DEDUP path has no grant to read the owner studio off (nothing was
    // uploaded), so /uploaded derives it from the project — the one place that
    // is still correct, since register is never reached there.
    resolveOwnerStudioId: vi
      .fn()
      .mockResolvedValue("s0000000-0000-4000-8000-000000000001"),
  },
  // Application-layer logger. Exposed on `mocks` (rather than inlined in the
  // core mock) so route tests can assert that a best-effort failure the library
  // layer reported as a SENTINEL — it may not log itself (@domain/CLAUDE.md) —
  // actually gets logged here. A swallowed sentinel is a silent failure.
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  // Canvas node lock (moved to @breatic/domain in PR4). Defaults: lock
  // acquires cleanly + no prior holder so happy-path routes succeed.
  canvasLock: {
    CANVAS_LOCK_TTL_SECONDS: 7200,
    canvasNodeLockKey: vi.fn(),
    acquireCanvasNodeLock: vi.fn().mockResolvedValue(true),
    readCanvasNodeLockHolder: vi.fn().mockResolvedValue(null),
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
    getRole: vi.fn().mockResolvedValue("viewer"),
    listByProjectId: vi.fn().mockResolvedValue([]),
    updateRole: vi.fn().mockResolvedValue(true),
    upsertMember: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(true),
  },
  notificationService: {
    getById: vi.fn().mockResolvedValue(null),
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
  // sendMail spy lives in `mocks` so tests can mockRejectedValueOnce
  // to verify dispatch try/catch graceful degradation, and assert
  // call args via expect(mocks.sendMail).toHaveBeenCalledWith(...).
  sendMail: vi.fn().mockResolvedValue({
    status: "skipped",
    reason: "backend_disabled",
  }),
  studioService: {
    createPersonalStudio: vi.fn().mockResolvedValue({
      id: "studio-1",
      createdByUserId: "user-1",
      slug: "personal-studio",
      type: "personal",
      name: "personal-studio",
    }),
    getPersonalStudio: vi.fn().mockResolvedValue({
      id: "studio-1",
      createdByUserId: "user-1",
      slug: "personal-studio",
      type: "personal",
      name: "Personal Studio",
    }),
    getPersonalStudioIdentitiesByUserIds: vi.fn().mockResolvedValue(new Map()),
  },
};

// Alias the auth service's user-read pass-throughs to the userRepo spies
// so route tests (which mock at the service boundary) and auth.service
// unit tests (which mock the repo directly) share a single control point.
mocks.authService.getUserById = mocks.userRepo.getUserById;
mocks.authService.getUsersByIds = mocks.userRepo.getUsersByIds;
// Notification read-by-id pass-through shares the repo spy for the same
// reason (the decision route now calls notificationService.getById).
mocks.notificationService.getById = mocks.notificationRepo.findById;

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
    publishNodeEvent: mocks.publishNodeEvent,
    getStorageAdapter: mocks.getStorageAdapter,
    // The mailer lives in core again (#40): collab needs to alert ops on a
    // failed store, and the package-ownership rule sends anything two
    // backends share to core. Route tests keep asserting through
    // `mocks.sendMail`, so it has to be overridden here rather than left
    // to the real implementation that `...actual` would supply.
    sendMail: mocks.sendMail,
    setSession: vi.fn(),
    getSession: vi.fn(),
    // Fixtures across this suite build cookie headers with the bare name;
    // the per-deployment suffix is covered by session-store's own test.
    sessionCookieName: () => "breatic_session",
    // Config
    env: { ENV: "dev", PORT: 3000, CREDIT_MULTIPLIER: 2.5, BRAVE_SEARCH_API_KEY: "test-search-key", ALLOWED_ORIGINS: "http://localhost:8000", COOKIE_DOMAIN: "", STORAGE_PROVIDER: "local", GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", PAYMENT_ENABLED: true, EMAIL_BACKEND: "disabled" },
    MONOREPO_ROOT: "/tmp",
    getAgentConfig: () => ({ default_model: "test", max_tool_iterations: 5, tool_result_keep: 3, memory_project_max_size: 1000, memory_conversation_max_size: 1000, max_output_tokens: 16384, memory_budget_chars: 850000, memory_keep_chars: 500000, user_message_max_chars: 15000, conversation_page_size: 30 }),
    // Values intentionally differ from config/storage.yaml so route tests
    // prove the endpoint reads config instead of hardcoding.
    getStorageConfig: () => ({
      upload: { max_upload_bytes: 1024, client_max_attempts: 2, client_retry_base_delay_ms: 250, client_request_timeout_ms: 5000, client_put_min_bytes_per_sec: 1024 },
    }),
    // Logger
    logger: { ...mocks.logger, child: () => mocks.logger },
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
    AppError: (mocks.appError = actual.AppError as typeof mocks.appError),
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
 * llm and the `ai` SDK behind it. Per-test overrides go through the
 * shared `mocks` refs (creditLotService / taskService / canvasLock / ...).
 */
export const domainMock = () => ({
  assetService: mocks.assetService,
  taskService: mocks.taskService,
  taskRepo: mocks.taskRepo,
  creditLotService: mocks.creditLotService,
  nodeHistoryService: mocks.nodeHistoryService,
  nodeHistoryRepo: mocks.nodeHistoryRepo,
  modelCatalog: { getModelCatalog: vi.fn().mockReturnValue({ image: [], video: [], audio: [] }) },
  listAvailableModels: vi.fn().mockReturnValue([]),
  // #1580 #7 credit pre-check inputs (canvas + mini-tools routes).
  MIN_TASK_CREDIT_COST: 5,
  estimateTaskCredits: vi.fn().mockReturnValue(5),
  violatesSourceRequirementForModel: mocks.violatesSourceRequirementForModel,
  violatesReferenceCountForModel: mocks.violatesReferenceCountForModel,
  getModel: vi.fn(),
  resolveProvider: vi.fn(),
  // Shaped like the real return so a turn built on this stub spreads the
  // same key it would in production. A bare `{}` would spread to nothing,
  // which reads as "this turn sent no provider options" -- the one thing
  // the real function never does.
  reasoningFor: vi.fn().mockReturnValue({ providerOptions: {} }),
  buildToolSet: vi.fn().mockReturnValue({}),
  BASELINE_TOOLS: [],
  // Not a placeholder and not written out by hand. What the turn does with
  // these names is match them against the names the model was offered, so a
  // stub that spells them itself is a second copy of the very thing being
  // matched -- and one written-out copy of them said `ask_user`, a tool that
  // does not exist, which is how a turn that should have stopped ran on.
  TOOLS_THAT_BLOCK: REAL_TOOLS_THAT_BLOCK,
  // Real so that a turn built on this stub throws the same detail the real
  // one does when a tool reports the stop itself.
  STOPPED_BY_USER: REAL_STOPPED_BY_USER,
  getSkillRegistry: () => ({
    get: (name: string) =>
      ["gated_fixture", "creative_research", "canvas_fixture", "canvas_gated"].includes(name)
        ? { name, description: "...", tools: [] }
        : undefined,
  }),
  // The gate both entry points call. Mirrors the real one's two outcomes:
  // 404 for a skill that does not exist, 403 for one the routing config
  // does not let a user fire from here.
  // Throws the real AppError, because the error handler identifies errors
  // with `instanceof` — a look-alike carrying the same `.status` comes back
  // as a 500. `mocks.appError` is set by coreMock, which does have it.
  // Mirrors the real gate's SHAPE, both parameters included. An earlier
  // version took only the name, which made every call site's surface
  // argument unobservable: swapping "chat" for "canvas" at a route changed
  // nothing any test could see, on the one axis this PR introduced.
  assertSkillUsable: (name: string, surface: string) => {
    const AppErrorClass = mocks.appError;
    const routes: Record<string, { surfaces: string[]; userInvocable: boolean }> = {
      creative_research: { surfaces: ["chat"], userInvocable: true },
      gated_fixture: { surfaces: ["chat"], userInvocable: false },
      canvas_fixture: { surfaces: ["canvas"], userInvocable: true },
      // Canvas serves it, but no user may fire it. Without this, a canvas
      // test aimed at the authorization axis is stopped by the surface axis
      // first and passes for the wrong reason.
      canvas_gated: { surfaces: ["canvas"], userInvocable: false },
    };
    const route = routes[name];
    if (!route) throw new AppErrorClass(404, `Skill '${name}' not found`);
    if (!route.surfaces.includes(surface)) {
      throw new AppErrorClass(403, `Skill '${name}' is not available here`);
    }
    if (!route.userInvocable) {
      throw new AppErrorClass(403, `Skill '${name}' is not user-invocable`);
    }
  },
  SkillRegistry: class {},
  extractPromptText: vi.fn((s: string) => s),
  ...mocks.canvasLock,
});

/**
 * Mock for `@server/modules/auth/user.repo.js` — the identity repo moved from
 * @breatic/core to @server in PR4. Tests that hit a route reading user
 * rows directly (canvas lock-holder lookup, batch /users) mock this path:
 *
 *   vi.mock("@server/modules/auth/user.repo.js", userRepoMock);
 */
export const userRepoMock = () => mocks.userRepo;

/**
 * Mock for `@server/modules` — the server-private domain (auth /
 * project / conversation / notification / ...) that moved
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
    assetUploadService: mocks.assetUploadService,
    // #89: the storage gate now sits on presign and task creation. Route
    // tests are about routing, so it answers "there is room" by default;
    // its own behaviour is pinned by the integration suites.
    assertStorageAllowance: mocks.assertStorageAllowance,
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
    notificationService: mocks.notificationService,
    notificationRepo: mocks.notificationRepo,
    roleUpgradeRequestService: mocks.roleUpgradeRequestService,
    studioService: mocks.studioService,
  };
};
