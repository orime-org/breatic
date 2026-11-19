// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, canConnect, templateAnchor } from "@breatic/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { ServerApiError } from "@mcp/server-api.js";
import {
  getCanvasCapabilities,
  getGenerationTemplate,
  listGenerationModels,
  listGenerationTemplates,
  listProjects,
  listSpaces,
  listVoices,
  readCanvas,
  readNodeHistory,
} from "@mcp/tools/read-tools.js";
import { stubDeps } from "@mcp/__tests__/tool-deps.js";

beforeAll(() => {
  loadLocales();
});

const PROJECT = randomUUID();
const SPACE = randomUUID();

describe("list_projects", () => {
  it("lists each Studio with every live Project the user can open, across pages", async () => {
    const { deps, calls } = stubDeps({
      api: (call) => {
        if (call.path === "/studios") return [{ id: "s1", slug: "acme", name: "Acme", myStudioRole: "admin", type: "team" }];
        if (call.query?.cursor === undefined) {
          return { items: [{ id: "p1", name: "One", myRole: "owner", lastEditedAt: "2026-11-01T00:00:00.000Z", slug: "x" }], nextCursor: "c2", total: 2 };
        }
        return { items: [{ id: "p2", name: "Two", myRole: "viewer", lastEditedAt: null }], nextCursor: null, total: null };
      },
    });
    const { value } = await listProjects.run(deps, {});
    expect(value).toEqual({
      studios: [
        {
          id: "s1",
          slug: "acme",
          name: "Acme",
          role: "admin",
          projects: [
            { id: "p1", name: "One", role: "owner", lastEditedAt: "2026-11-01T00:00:00.000Z" },
            { id: "p2", name: "Two", role: "viewer", lastEditedAt: null },
          ],
        },
      ],
    });
    expect(calls.slice(1).map((c) => [c.path, c.query?.cursor])).toEqual([
      ["/studio/acme/projects", undefined],
      ["/studio/acme/projects", "c2"],
    ]);
  });
});

describe("list_spaces", () => {
  it("asks collab for the Project's Spaces as the user", async () => {
    const spaces = [{ id: SPACE, type: "canvas", name: "Board" }];
    const { deps, submitted } = stubDeps({ reply: () => ({ status: "done", result: { spaces } }) });
    expect((await listSpaces.run(deps, { projectId: PROJECT })).value).toEqual({ spaces });
    expect(submitted.map((c) => [c.type, c.projectId, c.spaceId, c.params])).toEqual([["list_spaces", PROJECT, null, {}]]);
  });

  it("hands back the operation id when collab has not answered in the wait", async () => {
    const { deps } = stubDeps({ reply: () => "pending" });
    expect((await listSpaces.run(deps, { projectId: PROJECT })).value).toMatchObject({ status: "pending" });
  });
});

describe("read_canvas", () => {
  it("reads the canvas and names the people, authors and agents it mentions", async () => {
    const [you, other, author, replier, giver] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const connection = randomUUID();
    const annotation = {
      id: "a1",
      type: "annotation",
      position: { x: 0, y: 0 },
      data: {
        createdBy: author,
        replies: [{ id: "r1", content: "ok", createdBy: replier, createdAt: 1, via: connection }],
        assignment: { connectionId: connection, assignedBy: giver, assignedAt: 5, projectId: PROJECT },
      },
    };
    const result = {
      nodes: [annotation],
      edges: [],
      people: [
        { userId: you, you: true, selectedNodeIds: [], pointer: null },
        { userId: other, you: false, selectedNodeIds: ["a1"], pointer: { x: 1, y: 2 } },
      ],
    };
    const { deps, submitted, calls } = stubDeps({
      reply: () => ({ status: "done", result }),
      api: (call) => {
        if (call.path === "/users") return String(call.query?.ids).split(",").map((id) => ({ id, username: `name-${id.slice(0, 4)}`, email: "hidden@example.com", avatar_url: null }));
        if (call.path === "/agent-access/connections/names") return [{ id: connection, name: "Claude Code" }];
        throw new Error(call.path);
      },
    });
    const { value } = await readCanvas.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeIds: ["a1"] });
    expect(submitted.map((c) => [c.type, c.spaceId, c.params])).toEqual([["read_canvas", SPACE, { nodeIds: ["a1"] }]]);
    expect(value).toEqual({
      ...result,
      names: {
        users: Object.fromEntries([you, other, author, replier, giver].map((id) => [id, `name-${id.slice(0, 4)}`])),
        agents: { [connection]: "Claude Code" },
      },
    });
    expect(JSON.stringify(value)).not.toContain("hidden@example.com");
    expect(calls.map((c) => c.path).sort()).toEqual(["/agent-access/connections/names", "/users"]);
  });

  it("asks for no names when the canvas mentions nobody", async () => {
    const { deps, calls } = stubDeps({ reply: () => ({ status: "done", result: { nodes: [], edges: [], people: [] } }) });
    expect((await readCanvas.run(deps, { projectId: PROJECT, spaceId: SPACE })).value).toEqual({ nodes: [], edges: [], people: [], names: { users: {}, agents: {} } });
    expect(calls).toEqual([]);
  });
});

describe("get_canvas_capabilities", () => {
  it("lists the node types an agent can create, which generate and in which modes, and which connections the canvas allows", async () => {
    const { deps } = stubDeps();
    const { value } = (await getCanvasCapabilities.run(deps, {})) as { value: { nodeTypes: Array<{ type: string; generates: boolean; modes: string[] }>; connections: Array<{ from: string; to: string }> } };
    expect(value.nodeTypes.map((n) => n.type)).toEqual(["text", "image", "audio", "video"]);
    expect(value.nodeTypes.find((n) => n.type === "text")).toEqual({ type: "text", generates: false, modes: [] });
    expect(value.nodeTypes.find((n) => n.type === "image")?.modes).toContain("t2i");
    for (const { from, to } of value.connections) expect(canConnect(from, to)).toBe(true);
    expect(value.connections.length).toBeGreaterThan(0);
  });
});

describe("list_generation_models", () => {
  const catalog = {
    image: [
      { name: "img-a", display_name: "A", modality: "image", mode: ["t2i", "i2i"], tier: "recommended", description: "d", guide: "g", params: { size: { description: "s", default: "1k" } }, takes_prompt: true, generation_time: 10, availability: { upstreams: [] } },
      { name: "img-internal", display_name: "I", modality: "image", mode: ["t2i", "i2i"], tier: "internal", description: "", guide: "", params: {}, takes_prompt: true, generation_time: 1, availability: { upstreams: [] } },
    ],
    video: [{ name: "vid", display_name: "V", modality: "video", mode: "t2v", tier: "optional", description: "", guide: "", params: {}, takes_prompt: true, generation_time: 60, availability: { upstreams: [] } }],
    audio: [],
    tts: [{ name: "voice-1", display_name: "T", modality: "tts", mode: "tts", tier: "recommended", description: "", guide: "", params: {}, takes_prompt: true, generation_time: 5, availability: { upstreams: [] } }],
    three_d: [],
    total: 5,
    credit_multiplier: 1.5,
  };

  it("lists the models a node type and mode can use, leaving out internal ones and upstream detail", async () => {
    const { deps } = stubDeps({ api: () => catalog });
    const { value } = (await listGenerationModels.run(deps, { nodeType: "image", mode: "i2i" })) as { value: { models: Array<Record<string, unknown>>; creditMultiplier: number } };
    expect(value.models.map((m) => m.name)).toEqual(["img-a"]);
    expect(value.models[0]).not.toHaveProperty("availability");
    expect(value.models[0]).toMatchObject({ mode: ["t2i", "i2i"], params: { size: { default: "1k" } } });
    expect(value.creditMultiplier).toBe(1.5);
  });

  it("covers speech models under the audio node type", async () => {
    const { deps } = stubDeps({ api: () => catalog });
    const { value } = (await listGenerationModels.run(deps, { nodeType: "audio" })) as { value: { models: Array<{ name: string }> } };
    expect(value.models.map((m) => m.name)).toEqual(["voice-1"]);
  });
});

describe("list_voices", () => {
  it("asks the server for a model's voices with the search words", async () => {
    const page = { voices: [{ id: "v1", name: "Ava" }], hasMore: false };
    const { deps, calls } = stubDeps({ api: () => page });
    expect((await listVoices.run(deps, { model: "eleven/v3", query: "calm" })).value).toEqual(page);
    expect(calls).toEqual([{ method: "GET", path: "/models/eleven%2Fv3/voices", query: { query: "calm" } }]);
  });
});

describe("generation templates", () => {
  it("lists the templates a node type starts from, with their words in English", async () => {
    const { deps } = stubDeps();
    const { value } = (await listGenerationTemplates.run(deps, { nodeType: "video" })) as { value: { templates: Array<{ id: string; name: string; anchorType: string }> } };
    const expected = GENERATION_TEMPLATES.filter((t) => templateAnchor(t).type === "video").map((t) => t.id);
    expect(value.templates.map((t) => t.id)).toEqual(expected);
    expect(value.templates.every((t) => t.anchorType === "video" && t.name.length > 0 && !t.name.startsWith("canvas."))).toBe(true);
  });

  it("reads one template with each generate node's words resolved", async () => {
    const template = GENERATION_TEMPLATES[0]!;
    const { deps } = stubDeps();
    const { value } = (await getGenerationTemplate.run(deps, { id: template.id })) as { value: { id: string; nodes: Array<{ key: string; words?: unknown }> } };
    expect(value.id).toBe(template.id);
    const anchor = value.nodes.find((n) => n.key === template.anchor)!;
    expect(JSON.stringify(anchor.words)).not.toContain("canvas.template.");
  });

  it("refuses an id no template has", async () => {
    const { deps } = stubDeps();
    await expect(getGenerationTemplate.run(deps, { id: "no-such-template" })).rejects.toMatchObject({ reason: "not_found" });
  });
});

describe("read_node_history", () => {
  it("reads a node's history in its Project and keeps the agent shown on that node", async () => {
    const page = { entries: [{ id: "h1", status: "success" }], total: 1 };
    const nodeId = randomUUID();
    const { deps, calls, sent } = stubDeps({ api: () => page });
    expect((await readNodeHistory.run(deps, { projectId: PROJECT, nodeId, status: "success", limit: 5, offset: 10 })).value).toEqual(page);
    expect(calls).toEqual([{ method: "GET", path: `/canvas/nodes/${nodeId}/history`, query: { project_id: PROJECT, status: "success", limit: "5", offset: "10" } }]);
    expect(sent.map((c) => [c.type, c.projectId, c.params])).toEqual([["touch_presence", PROJECT, { focus: [nodeId] }]]);
  });

  it("passes on the server's refusal", async () => {
    const { deps } = stubDeps({
      api: () => {
        throw new ServerApiError(404, "Not found");
      },
    });
    await expect(readNodeHistory.run(deps, { projectId: PROJECT, nodeId: randomUUID() })).rejects.toBeInstanceOf(ServerApiError);
  });
});
