// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Transitions execution admission (inner#1306 test plan §97 D11-3, D12-1, D12-2, D13-1, D15-3 to D15-7; frames-split design
 * §7.11 fresh row, §5.4 派发, 预算 and 上限 rows, §7.17 转场输出档 row).
 *
 * Real admission, authorization, PG, Redis, holds and queue; only the external presentation snapshots (ingest) and the
 * stored ledger objects (fetch) are controlled, as in planned-lipsync-admission. The configuration is the deployment's
 * own (`config/mini-tools.yaml`), changed only in `encoding.max_parallel_chunks`. Both clips are presented by
 * presentation-fixtures (1011 frames of 1/200 s at 960×540), so the output grid is 200 fps.
 *
 * A fresh two-clip request is admitted and freezes, beside the shared fields: the transition layout
 * (`TransitionExecutionLayout`, `planTransitionChunks` over `planVideoTimeline(clips, profile.fps)`), its `stageJobs`
 * (`plannedStageJobs(layout)`), the output `profile` (`transitionOutputProfile(first, second, { encode })` of the two
 * clips' selected plans in timeline order, encode from `presentation.crf` / `preset`), and the container class of each
 * job kind: `container` (standard-4: `chunk_encode` and `stitch`) and `windowContainer` (`MiniToolContainerGl`:
 * `transition_window`). Under the default configuration each region is one chunk: a 0.5 s fade over 4 s + 4 s clips is
 * encode [0, 700) and [800, 1500), window [700, 800). Field names chosen here: `profile`, `windowContainer`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import * as shared from "@breatic/shared";
import { containerCostUsd, creditsForUsd, MIN_TASK_CREDIT_COST } from "@breatic/domain";
import { estimateAudioEncodeSeconds, planTransitionChunks, plannedStageJobs, planVideoTimeline, transitionOutputProfile } from "@breatic/shared/mini-tools";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { presentedSource, REMOVAL_ENCODING, REMOVAL_PLAN, type ToolInputRef } from "./presentation-fixtures.js";

type Transition = { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number };
interface Clip { clipId: string; inputId: string; in: number; out: number; transition: Transition }
interface Media { width: number; height: number; duration: number; mimeType: string }
interface Body {
  tool: "video.transitions"; project_id: string; space_id: string; run_id: string;
  draft: { version: 1; draftId: string; revision: string; source: { nodeId: string; canonicalURL: string; mediaInfo: Media };
    inputs: { inputId: string; url: string; mediaInfo: Media; sourceNodeId: string }[]; params: { clips: Clip[] } };
  analysis_refs: []; presentation_ref: Record<string, ToolInputRef>;
  outputs: { outputIndex: number; nodeId: string; recipe: { kind: "transitions" } }[];
}
interface Fixture extends StudioFixture { body: Body; current: string; picked: string }
type Window = { start: number; end: number };
interface Plan extends Record<string, unknown> {
  tool: string; credits: number; presentationRef: Record<string, ToolInputRef>; layout: { encode: Window[]; window: Window[] }; stageJobs: { stage: string; jobs: number }[];
  profile: Record<string, unknown>; container: { containerClass: string }; windowContainer: { containerClass: string };
}

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn(), config: vi.fn() }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

// presentation-fixtures: display duration 1011/200 s.
const MEDIA: Media = { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" };
const FADE: Transition = { kind: "fade", duration: 0.5 };
const CUT: Transition = { kind: "cut", duration: 0 };
/** A selected plan and its encode facts. */
type Presented = { plan: typeof REMOVAL_PLAN; encoding: typeof REMOVAL_ENCODING };
const LARGE: Presented = { plan: REMOVAL_PLAN, encoding: REMOVAL_ENCODING };
// The same 1011 frames of 1/200 s and keyframes, displayed and coded at 160×90.
const SMALL: Presented = { plan: { ...REMOVAL_PLAN, display: { ...REMOVAL_PLAN.display, width: 160, height: 90 } }, encoding: { ...REMOVAL_ENCODING, codedWidth: 160, codedHeight: 90 } };

let pg: ReturnType<typeof core.createPgClient>;
let queue: Queue;
let app: Hono;
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
const tokens: string[] = [];

/** Configure a real paid admission without any provider key or external call. @throws {Error} On invalid deployment configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", STRIPE_SECRET_KEY: "sk_test_unused_transitions",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_transitions", UPLOAD_BASE_URL: "https://assets.example.test" });
}

beforeAll(async () => {
  configure(); core.loadLocales(); core.initLogger("transitions-admission-test");
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "transitions-admission-fixtures", max: 8 });
  const storage = await core.getStorageAdapter();
  publicUrl = storage.publicUrl.bind(storage);
  queue = core.createQueue("tasks");
  app = (await import("@server/app.js")).createApp();
});
beforeEach(() => {
  configure();
  settings = structuredClone(base);
  outside.config.mockImplementation(() => settings);
  outside.snapshots.clear(); outside.bodies.clear();
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = outside.bodies.get(url);
    if (body === undefined) throw new Error(`Admission must not fetch an unregistered URL: ${url}`);
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => {
  for (const token of tokens) await core.revokeSession(core.getRedis(), token);
  await pg.end(); core.initCore(process.env); vi.unstubAllGlobals();
});

/**
 * Register one video in the Studio and declare its selected, ready tool input.
 * @param target - The Studio.
 * @param presented - Its selected plan and encode facts.
 * @returns Its public URL and tool-input ref.
 * @throws {Error} On fixture SQL failure.
 */
async function registered(target: StudioFixture, presented: Presented = LARGE): Promise<{ url: string; ref: ToolInputRef }> {
  const id = randomUUID(); const key = `video/transitions/${id}.mp4`; const hash = randomBytes(32).toString("hex");
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${id},${target.studioId},${hash},${key},${publicUrl(key)},4096,'video/mp4','video','upload',${target.userId},${presented.plan.display.width},${presented.plan.display.height},${MEDIA.duration})`;
  const source = await presentedSource(hash, key, publicUrl, presented);
  outside.snapshots.set(key, source.snapshot);
  for (const [url, body] of source.bodies) outside.bodies.set(url, body);
  return { url: publicUrl(key), ref: source.presentationRef.source };
}

/**
 * A funded Studio, the host node's current video and one picked video, and a request playing the current video for
 * 4 s, then the transition, then the picked video for 4 s.
 * @param transition - The transition between the clips.
 * @param timing - Each clip's out point and the picked video's plan.
 * @param timing.currentOut - The current video's out point.
 * @param timing.pickedOut - The picked video's out point.
 * @param timing.picked - The picked video's plan.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure.
 */
async function seed(transition: Transition = FADE, timing: { currentOut: number; pickedOut: number; picked: Presented } = { currentOut: 4, pickedOut: 4, picked: LARGE }): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "transitions");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
  await seedDesignatedLot(pg, target, 1000);
  const host = randomUUID(); const current = randomUUID(); const picked = randomUUID();
  const a = await registered(target); const b = await registered(target, timing.picked);
  const body: Body = { tool: "video.transitions", project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
    draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: host, canonicalURL: a.url, mediaInfo: MEDIA },
      inputs: [{ inputId: current, url: a.url, mediaInfo: MEDIA, sourceNodeId: host }, { inputId: picked, url: b.url, mediaInfo: MEDIA, sourceNodeId: randomUUID() }],
      params: { clips: [{ clipId: randomUUID(), inputId: current, in: 0, out: timing.currentOut, transition }, { clipId: randomUUID(), inputId: picked, in: 0, out: timing.pickedOut, transition: CUT }] } },
    analysis_refs: [], presentation_ref: { [current]: a.ref, [picked]: b.ref },
    outputs: [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: "transitions" } }] };
  return { ...target, body, current, picked };
}

/** Drive the real HTTP auth, idempotency, validation and planned startup. @throws {Error} On session storage or client failure. */
async function post(f: Fixture, body: Body = f.body): Promise<Response> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
  return app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(body) });
}

/** Require a real admission. @throws {Error} On assertion failure. */
async function accept(f: Fixture, body: Body = f.body): Promise<void> {
  const response = await post(f, body);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 201, body: { data: { task_id: body.run_id, status: "pending" } } });
}

/** The frozen plan of an admitted run. @throws {Error} When the task is missing. */
async function frozen(id: string): Promise<Plan> {
  const [row] = await pg<{ params: { miniToolExecution: Plan } }[]>`SELECT params FROM tasks WHERE id=${id}`;
  if (!row) throw new Error("Missing admitted transitions task");
  return row.params.miniToolExecution;
}

/** Count only this run's original owners. @throws {Error} On SQL or queue failure. */
async function effects(id: string): Promise<{ tasks: number; rows: number; holds: number; jobs: number }> {
  const [count] = await pg<{ tasks: number; rows: number; holds: number }[]>`SELECT
    (SELECT count(*)::int FROM tasks WHERE id=${id}) AS tasks,
    (SELECT count(*)::int FROM node_tasks WHERE task_id=${id}) AS rows,
    (SELECT count(*)::int FROM credit_holds WHERE reference_id=${id}) AS holds`;
  if (!count) throw new Error("Missing count projection");
  return { ...count, jobs: await queue.getJob(id) ? 1 : 0 };
}

/** The output profile both clips' selected plans give (D13-1, D15-5). @throws {RangeError} Never for the fixture plan. */
function expectedProfile(): ReturnType<typeof transitionOutputProfile> {
  // The fixture plan's empty fill is the literal "black"; only its widened type needs naming.
  const plan = REMOVAL_PLAN as Parameters<typeof transitionOutputProfile>[0];
  return transitionOutputProfile(plan, plan, { encode: { crf: settings.presentation.crf, preset: settings.presentation.preset } });
}

describe("transitions admission freezes its layout, stage counts and output profile (§97 D11-3, D12-1, D13-1, D15-3..D15-7)", () => {
  it("TA01 admits a fade between the current and the picked video and freezes encode and window chunks, their stages and the profile", async () => {
    const f = await seed();
    await accept(f);
    const plan = await frozen(f.body.run_id);
    const profile = expectedProfile();
    // The output grid is the first clip's frame rate: 200 fps; the window is 100 frames ending where the first clip ends.
    expect(profile.fps).toEqual({ numerator: "200", denominator: "1" });
    const timeline = planVideoTimeline(f.body.draft.params.clips, profile.fps);
    expect(timeline.window).toEqual({ startFrame: 700, frameCount: 100, kind: "fade" });
    expect(plan).toMatchObject({ tool: "video.transitions", presentationRef: f.body.presentation_ref, profile });
    expect(plan.layout).toEqual({ encode: [{ start: 0, end: 700 }, { start: 800, end: 1500 }], window: [{ start: 700, end: 800 }] });
    expect(plan.layout).toEqual(planTransitionChunks(timeline, timeline.frameCount));
    expect(plan.stageJobs).toEqual(plannedStageJobs(plan.layout));
    expect(plan.stageJobs).toEqual([{ stage: "encode", jobs: 3 }, { stage: "stitch", jobs: 1 }]);
  });

  it("TA02 freezes chunk_encode and stitch on standard-4 and transition_window on MiniToolContainerGl (§5.4 派发 row)", async () => {
    const f = await seed();
    await accept(f);
    const plan = await frozen(f.body.run_id);
    expect(plan.container).toMatchObject({ containerClass: "MiniToolContainerStd4" });
    expect(plan.windowContainer).toMatchObject({ containerClass: "MiniToolContainerGl" });
  });

  it("TA03 a Cut freezes no window chunk and one encode chunk per clip", async () => {
    const f = await seed(CUT);
    await accept(f);
    const plan = await frozen(f.body.run_id);
    expect(plan.layout).toEqual({ encode: [{ start: 0, end: 800 }, { start: 800, end: 1600 }], window: [] });
    expect(plan.stageJobs).toEqual([{ stage: "encode", jobs: 2 }, { stage: "stitch", jobs: 1 }]);
    expect(plan.profile).toEqual(expectedProfile());
  });

  it("TA04 admits a fade whose total jobs exceed the parallel cap while its largest stage does not", async () => {
    const f = await seed();
    settings.encoding.max_parallel_chunks = 3;
    await accept(f);
    expect((await frozen(f.body.run_id)).stageJobs).toEqual([{ stage: "encode", jobs: 3 }, { stage: "stitch", jobs: 1 }]);
  });

  it("TA05 refuses a fade whose largest stage exceeds the parallel cap with runTooLong and no durable effect", async () => {
    const control = await seed();
    await accept(control);
    const f = await seed();
    settings.encoding.max_parallel_chunks = 2;
    const response = await post(f);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(shared.t("server.mini_tool.runTooLong", { max: 2 }));
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
});

// frames-split §5.4 待实测 row (转场导出的块): each chunk's decode is summed per clip, that clip's decoded source frames in the
// chunk (from the full ledger, pre-roll included) × its coded source pixels ÷ its bit-depth and range tier's decode rate;
// encode is the chunk's output frames × output pixels ÷ the encode rate; a window chunk adds its output frames × output
// pixels ÷ the GL render rate, configured under the MiniToolContainerGl class (chosen here:
// `classes.MiniToolContainerGl.render_pixels_per_second`). Every job adds its start; the stitch's term is the one AAC track
// as admission prices it today. The quote is that work at the standard-4 price, never under the precheck floor.
describe("the transitions quote decodes each clip at its own size (§97; frames-split §5.4 待实测 row)", () => {
  it("TE01 a large current video then a long small one: the frozen credits are the per-clip sum, not every frame at the larger size", async () => {
    const encoder = settings.encoding.encoder;
    for (const tier of Object.keys(encoder.decode_convert_pixels_per_second) as (keyof typeof encoder.decode_convert_pixels_per_second)[]) {
      encoder.decode_convert_pixels_per_second[tier] = 500_000;
    }
    encoder.encode_pixels_per_second = 1e12;
    const GL_RATE = 1e9;
    Reflect.set(settings.classes.MiniToolContainerGl!, "render_pixels_per_second", GL_RATE);
    // 2 s of the 960×540 current video, a 0.5 s fade, then 5 s of the 160×90 picked video: 1000 of 1300 output frames are small.
    const f = await seed(FADE, { currentOut: 2, pickedOut: 5, picked: SMALL });
    await accept(f);
    const plan = await frozen(f.body.run_id);
    const profile = expectedProfile();
    const timeline = planVideoTimeline(f.body.draft.params.clips, profile.fps);
    expect(timeline.frameCount).toBe(1300);
    const decodeRate = 500_000;
    const sources = [LARGE, SMALL].map((presented) => presented.encoding.codedWidth * presented.encoding.codedHeight);
    const outputPixels = profile.width * profile.height;
    // Both clips present at the output's 200 fps from in point 0, so output frame k of clip c is its presentation frame
    // k − startFrame; a span's pre-roll counts back to the latest keyframe ordinal not after its first frame.
    const preroll = (first: number): number => first - Math.max(...REMOVAL_ENCODING.keyframeOrdinals.filter((ordinal) => ordinal <= first));
    const decode = (chunk: { start: number; end: number }): number => timeline.clips.reduce((total, clip, c) => {
      const low = Math.max(chunk.start, clip.startFrame); const high = Math.min(chunk.end, clip.startFrame + clip.frameCount);
      if (high <= low) return total;
      const first = clip.inFrame + (low - clip.startFrame);
      return total + (high - low + preroll(first)) * sources[c]! / decodeRate;
    }, 0);
    const chunks = [...plan.layout.encode, ...plan.layout.window];
    const windowFrames = plan.layout.window.reduce((total, chunk) => total + chunk.end - chunk.start, 0);
    const audio = estimateAudioEncodeSeconds(timeline.frameCount / 200, { startSeconds: encoder.start_seconds, aacEncodeSecondsPerSecond: encoder.aac_encode_seconds_per_second });
    const fixed = timeline.frameCount * outputPixels / encoder.encode_pixels_per_second + windowFrames * outputPixels / GL_RATE + encoder.start_seconds * chunks.length + audio;
    const perClip = chunks.reduce((total, chunk) => total + decode(chunk), 0) + fixed;
    const largest = timeline.frameCount * Math.max(...sources) / decodeRate + fixed;
    const precheck = settings.executions["video.transitions"]!.precheck_seconds;
    /** The standard-4 quote of planned seconds, never under the precheck floor. @throws {never} Never. */
    const credits = (seconds: number): number => Math.max(shared.ceilToCreditCent(creditsForUsd(containerCostUsd({ wallMs: Math.max(precheck, seconds) * 1000, cpuUsec: null },
      settings.classes.MiniToolContainerStd4!, settings.prices), 1)), MIN_TASK_CREDIT_COST);
    expect(perClip).toBeGreaterThan(precheck);
    expect(credits(largest)).not.toBe(credits(perClip));
    expect(plan.credits).toBe(credits(perClip));
  });
});
