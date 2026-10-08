// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a node task was doing (inner#888 §7.7). The row's first line names it,
 * so the reader tells an upload from a generation from a tool run whatever
 * state the row is in. `kind` stays the behaviour (`upload` / `generation`)
 * the server settles by; this is what the row says.
 */
export const NODE_TASK_ACTIONS = ["upload", "generate", "understand", "mini_tool"] as const;

/** One of {@link NODE_TASK_ACTIONS}. */
export type NodeTaskAction = (typeof NODE_TASK_ACTIONS)[number];

/**
 * One row of a node's task list, as `GET /canvas/nodes/:id/tasks` hands it
 * back (#186).
 *
 * `content`, `coverUrl` and the media numbers are read across server-side
 * from the history row this task names. `coverUrl` is that row's thumbnail:
 * a video's cover, or for an image a preview of the content. They are present
 * on a task that landed something, including one judged expired before its
 * report arrived.
 */
export interface NodeTaskEntry {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  /** `upload` or `generation`. */
  kind: string;
  action: NodeTaskAction;
  status: "running" | "done" | "failed" | "expired";
  startedByUserId: string;
  /** Server time the task opened, ISO 8601. */
  startedAt: string;
  /** Server time it reached its end state, ISO 8601; `null` while it runs. */
  settledAt: string | null;
  /** The conservative allowance this task was given, in ms. */
  budgetMs: number;
  /** The file name or address for an upload, the model id for a run, the tool id for a mini-tool. */
  label: string;
  errorMessage: string | null;
  nodeHistoryId: string | null;
  content: string | null;
  coverUrl: string | null;
  /**
   * The media numbers this content landed on the node with (#2184), under the
   * node's own field names; a restore writes them back. Null when the medium
   * has no such number, and on rows written before they were kept.
   */
  mediaWidth: number | null;
  mediaHeight: number | null;
  duration: number | null;
  mimeType: string | null;
  size: number | null;
}
