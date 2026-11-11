// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790): the `doc:size` push
 * fixtures of web test spec 0.3 and the copy literals of spec 0.5.
 *
 * A fixture holds a push's `bytes`, `limit`, `ceiling` and `phase`. Values are
 * written out, never computed from the implementation. Default configuration:
 * limit 10485760, warning ratio 0.9, delete headroom 262144, ceiling 10747904.
 * Send one with `push(provider, P_FULL)` from `doc-size-driver.ts`, which adds
 * `type: 'doc:size'` and the next `seq`.
 */

/** One valid v2 `doc:size` push without its `type` and `seq` fields. */
export interface DocSizePushV2 {
  bytes: number;
  limit: number;
  ceiling: number;
  phase: 'normal' | 'warning' | 'full';
}

export const P_NORMAL: DocSizePushV2 = { bytes: 1048576, limit: 10485760, ceiling: 10747904, phase: 'normal' };
export const P_WARNING: DocSizePushV2 = { bytes: 9437184, limit: 10485760, ceiling: 10747904, phase: 'warning' };
export const P_FULL: DocSizePushV2 = { bytes: 10485760, limit: 10485760, ceiling: 10747904, phase: 'full' };
export const P_FULL_EDGE: DocSizePushV2 = { bytes: 10747903, limit: 10485760, ceiling: 10747904, phase: 'full' };
export const P_CEIL: DocSizePushV2 = { bytes: 10747904, limit: 10485760, ceiling: 10747904, phase: 'full' };
export const P_OVER: DocSizePushV2 = { bytes: 12582912, limit: 10485760, ceiling: 10747904, phase: 'full' };
export const P_UNLIMITED: DocSizePushV2 = { bytes: 0, limit: 0, ceiling: 0, phase: 'normal' };
export const P_UNLIMITED_FULL: DocSizePushV2 = { bytes: 12582912, limit: 0, ceiling: 0, phase: 'full' };

/** Every fixture by its spec name. */
export const PUSHES_V2 = {
  P_NORMAL, P_WARNING, P_FULL, P_FULL_EDGE, P_CEIL, P_OVER, P_UNLIMITED, P_UNLIMITED_FULL,
} as const;

/** `formatBytes(n)` for the fixtures' byte counts (spec 0.3). */
export const FORMATTED_BYTES_V2: ReadonlyArray<readonly [number, string]> = [
  [1048576, '1 MiB'],
  [9437184, '9 MiB'],
  [10485760, '10 MiB'],
  [10747903, '10.2 MiB'],
  [10747904, '10.3 MiB'],
  [12582912, '12 MiB'],
];

/** Copy literals (spec 0.5), English. */
export const COPY_V2_EN = {
  N_WARNING: (u: string, l: string): string => `This Space is using ${u}. Once it passes ${l}, no more content can be added.`,
  N_FULL: (u: string, l: string): string => `This Space is full (${u} of ${l}). You can only delete content until it is back under the limit.`,
  N_OVER: (u: string, l: string): string => `This Space is over its limit (${u} of ${l}). You can only delete whole items: a node, a clip, a model or a whole passage.`,
  T_ADD: 'This Space is full. Delete some content before editing further.',
  T_COMPOUND: 'This Space is full. This deletion would also change other content, so it cannot run right now.',
  T_OVER: 'This Space is over its limit. Delete whole items: a node, a clip, a model or a whole passage.',
  T_OVER_CLIP: 'This Space is over its limit. Delete a whole clip.',
  T_RESYNC: 'Your last change went over this Space\'s size limit and was not saved.',
  T_PROPOSAL: 'This Space is full, so the proposal was not placed.',
  T_REASON: 'This Space is full.',
  T_TEXT: 'Text not added: this Space is full.',
  T_WAIT: 'This Space is full. It will finish once some content is deleted.',
} as const;

/** Copy literals (spec 0.5), Simplified Chinese. */
export const COPY_V2_ZH_CN = {
  N_WARNING: (u: string, l: string): string => `这个 Space 已用 ${u}，超过 ${l} 后将不能再添加内容。`,
  N_FULL: (u: string, l: string): string => `这个 Space 已满（${u} / ${l}），只能删除内容，降到上限以下后才能继续编辑。`,
  N_OVER: (u: string, l: string): string => `这个 Space 已超出上限（${u} / ${l}），只能整个删除节点、片段、模型或整段内容。`,
  T_ADD: '这个 Space 已满，删除一些内容后才能继续编辑。',
  T_COMPOUND: '这个 Space 已满，这项删除还要改动其他内容，暂时不能执行。',
  T_OVER: '这个 Space 已超出上限，请整个删除节点、片段、模型或整段内容。',
  T_OVER_CLIP: '这个 Space 已超出上限，请删除整个片段。',
  T_RESYNC: '你刚才的改动超出了这个 Space 的大小上限，没有保存。',
  T_PROPOSAL: '这个 Space 已满，提案没有放进去。',
  T_REASON: '这个 Space 已满。',
  T_TEXT: '文字没有写入：这个 Space 已满。',
  T_WAIT: '这个 Space 已满，删除一些内容后会自动完成。',
} as const;
