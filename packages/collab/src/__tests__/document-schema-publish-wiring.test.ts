// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 发布这件事**真的接上了**（验收 10 的接线那一半）。
 *
 * `document-schema-publisher.test.ts` 测的是「调了它会怎样」；这里测的是
 * 「`hocuspocus.ts` 到底会不会为一个 meta 文档调它」。两者缺一不可 —— 接线
 * 断了的话，前端永远收不到服务器那份清单，条件一从此不会成立一次，而没有
 * 任何东西会报错。
 *
 * 做法：把 `Server` 换成一个只记下配置的替身，从记下的配置里取出真正的
 * `afterLoadDocument`，拿一份真的 Yjs 文档去调它。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  DOCUMENT_SCHEMA_META_KEY,
  projectMetaDocName,
  spaceContentDocName,
} from "@breatic/shared";
import { getDocumentSchema } from "@breatic/core";

const { serverSpy } = vi.hoisted(() => ({ serverSpy: vi.fn() }));

vi.mock("@hocuspocus/extension-redis", () => ({
  Redis: class {
    constructor() {
      /* 这条测试不碰跨实例的那一半。 */
    }
  },
}));

vi.mock("@hocuspocus/server", () => ({
  Server: class {
    hocuspocus = { documents: new Map() };
    constructor(config: unknown) {
      serverSpy(config);
    }
  },
}));

vi.mock("@breatic/core", async () => ({
  // 真的那份：这条测试要验「发布真的接上了」，而发布写进去的值就来自它。
  // 换成替身就等于自己规定了答案再去核对它。
  getDocumentSchema: (
    await vi.importActual<typeof import("@breatic/core")>("@breatic/core")
  ).getDocumentSchema,
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createRedisClient: vi.fn(() => ({ on: vi.fn() })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => ({ on: vi.fn() })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  MONOREPO_ROOT: "/tmp",
}));

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    count: vi.fn(async () => 0),
  })),
}));

vi.mock("@collab/services/handling-sweeper.js", () => ({
  createHandlingSweeper: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  scheduleLoadSweep: vi.fn(),
  resolveLeaseBudget: vi.fn(() => 3_600_000),
}));

import { createCollabServer } from "../hocuspocus.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

type LoadHook = (payload: {
  documentName: string;
  document: Y.Doc;
  instance: { documents: Map<string, unknown> };
}) => Promise<void>;

/**
 * 起一次服务器，把它真正挂上去的那个加载钩子取出来。
 * @returns 真正的 `afterLoadDocument`。
 */
async function loadHook(): Promise<LoadHook> {
  serverSpy.mockClear();
  await createCollabServer({
    collabRedisUrl: "redis://localhost:6379/3",
    port: 1234,
    redisKeyPrefix: "test",
  });
  const config = serverSpy.mock.calls[0]?.[0] as {
    afterLoadDocument?: LoadHook;
  };
  const hook = config.afterLoadDocument;
  if (!hook) throw new Error("afterLoadDocument 根本没有挂上去");
  return hook;
}

/**
 * 读文档里发布出来的那份清单。
 * @param doc - 被检查的文档。
 * @returns 那个键下的内容。
 */
function published(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap(DOCUMENT_SCHEMA_META_KEY).toJSON();
}

describe("meta 文档加载时", () => {
  let hook: LoadHook;

  beforeEach(async () => {
    hook = await loadHook();
  });

  it("这一版的 schema 被写进去了", async () => {
    const doc = new Y.Doc();

    await hook({
      documentName: projectMetaDocName(PID),
      document: doc,
      instance: { documents: new Map() },
    });

    expect(published(doc).nodes).toEqual(getDocumentSchema().nodes);
    expect(published(doc).marks).toEqual(getDocumentSchema().marks);
    expect(typeof published(doc).publishedAt).toBe("string");
    doc.destroy();
  });

  it("第二次加载不重写 —— 时间戳说的是「什么时候变的」，不是「什么时候被打开的」", async () => {
    const doc = new Y.Doc();
    const payload = {
      documentName: projectMetaDocName(PID),
      document: doc,
      instance: { documents: new Map() },
    };

    await hook(payload);
    const firstAt = published(doc).publishedAt;
    await hook(payload);

    expect(published(doc).publishedAt).toBe(firstAt);
    doc.destroy();
  });
});

describe("别的文档加载时", () => {
  it("画布文档不被写进 schema —— 那是 meta 的事", async () => {
    const hook = await loadHook();
    const doc = new Y.Doc();

    await hook({
      documentName: spaceContentDocName(PID, SID, "canvas"),
      document: doc,
      instance: { documents: new Map() },
    });

    expect(published(doc)).toEqual({});
    doc.destroy();
  });

  it("document space 的正文文档也不被写", async () => {
    const hook = await loadHook();
    const doc = new Y.Doc();

    await hook({
      documentName: spaceContentDocName(PID, SID, "document"),
      document: doc,
      instance: { documents: new Map() },
    });

    expect(published(doc)).toEqual({});
    doc.destroy();
  });
});
