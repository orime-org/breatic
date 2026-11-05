// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790): the `doc:size` push fixtures and the
 * copy literals every web test of the cap shares.
 *
 * Values are written out, never computed from the implementation, so a change
 * to the server formula or to `formatBytes` shows up as a failing test instead
 * of a silently moved expectation. Default configuration: limit 10485760,
 * headroom 262144, delete headroom 262144, overwrite reserve 65536, so
 * `ceiling = 10747904`, `room = max(0, limit - 262144 - bytes)` and
 * `overwriteRoom = max(0, ceiling - bytes - 65536)`.
 */

/** One valid `doc:size` push without its `type` field. */
export interface DocSizePush {
  bytes: number;
  limit: number;
  ceiling: number;
  room: number;
  overwriteRoom: number;
  phase: 'normal' | 'warning' | 'full';
}

export const F_NORMAL: DocSizePush = { bytes: 1048576, limit: 10485760, ceiling: 10747904, room: 9175040, overwriteRoom: 9633792, phase: 'normal' };
export const F_WARNING: DocSizePush = { bytes: 9437184, limit: 10485760, ceiling: 10747904, room: 786432, overwriteRoom: 1245184, phase: 'warning' };
export const F_WARNING_TIGHT: DocSizePush = { bytes: 10223615, limit: 10485760, ceiling: 10747904, room: 1, overwriteRoom: 458753, phase: 'warning' };
export const F_FULL: DocSizePush = { bytes: 10223616, limit: 10485760, ceiling: 10747904, room: 0, overwriteRoom: 458752, phase: 'full' };
export const F_FULL_NEAR_MINUS1: DocSizePush = { bytes: 10682367, limit: 10485760, ceiling: 10747904, room: 0, overwriteRoom: 1, phase: 'full' };
export const F_FULL_NEAR: DocSizePush = { bytes: 10682368, limit: 10485760, ceiling: 10747904, room: 0, overwriteRoom: 0, phase: 'full' };
export const F_AT_CEILING: DocSizePush = { bytes: 10747904, limit: 10485760, ceiling: 10747904, room: 0, overwriteRoom: 0, phase: 'full' };
export const F_OVER: DocSizePush = { bytes: 10747905, limit: 10485760, ceiling: 10747904, room: 0, overwriteRoom: 0, phase: 'full' };
export const F_OVER_BIG: DocSizePush = { bytes: 12582912, limit: 10485760, ceiling: 10747904, room: 0, overwriteRoom: 0, phase: 'full' };
export const F_UNLIMITED: DocSizePush = { bytes: 0, limit: 0, ceiling: 0, room: 0, overwriteRoom: 0, phase: 'normal' };
export const F_AFTER_WRITE: DocSizePush = { bytes: 9937184, limit: 10485760, ceiling: 10747904, room: 286432, overwriteRoom: 745184, phase: 'warning' };

/** `formatBytes(n)` for every byte count the size-cap tests show (spec 0.2). */
export const FORMATTED_BYTES: ReadonlyArray<readonly [number, string]> = [
  [1048576, '1 MiB'],
  [9437184, '9 MiB'],
  [10223615, '9.7 MiB'],
  [10223616, '9.8 MiB'],
  [10682367, '10.2 MiB'],
  [10682368, '10.2 MiB'],
  [10747904, '10.3 MiB'],
  [10747905, '10.3 MiB'],
  [12582912, '12 MiB'],
  [9937184, '9.5 MiB'],
  [786432, '768 KiB'],
  [286432, '279.7 KiB'],
  [10485760, '10 MiB'],
  [1, '1 B'],
  [0, '0 B'],
  [8388608, '8 MiB'],
];

/**
 * The wire payload of one push, as collab sends it on the provider's stateless channel.
 * @param push - The fixture, optionally with extra or broken fields.
 * @returns The serialized `doc:size` message.
 * @throws {never} Never.
 */
export function docSizePayload(push: object): string {
  return JSON.stringify({ type: 'doc:size', ...push });
}

/** Copy literals of the size cap (design 5.4 and the demo `COPY`), English. */
export const COPY_EN = {
  T_WARNING: (u: string, l: string): string => `This Space is using ${u} of its ${l}.`,
  T_FULL_NOTICE: (u: string, l: string): string => `This Space is full (${u} of ${l}). Delete some content to add more.`,
  T_ADD_BLOCKED: 'This Space is full. Delete some content to add more.',
  T_OVERWRITE_BLOCKED: 'This Space is full. Moving or changing things is paused until you delete some content.',
  T_NO_ROOM: (r: string): string => `This doesn't fit — the Space has ${r} left.`,
  T_OVER_CEILING_DELETE: 'This Space is over its limit. Delete a whole node or a whole passage.',
  T_TIMELINE_FULL: 'This Space is full and cannot take more.',
  T_3D_FULL: 'This Space is full and can no longer be edited.',
  T_RESYNC: 'Your last change went over this Space\'s size limit and was not saved.',
  T_PROPOSAL_FULL: 'This Space is full, so the proposal was not placed.',
  T_PROPOSAL_NO_ROOM: (r: string): string => `This doesn't fit — the Space has ${r} left, so the proposal was not placed.`,
  T_UPLOAD_FAILED: 'Upload failed',
  T_SPACE_FULL_REASON: 'This Space is full.',
  T_TEXT_NO_ROOM: (r: string): string => `Text not added: this doesn't fit — the Space has ${r} left.`,
  T_TEXT_FULL: 'Text not added: this Space is full.',
} as const;

/** Copy literals of the size cap (design 5.4 and the demo `COPY`), Simplified Chinese. */
export const COPY_ZH_CN = {
  T_WARNING: (u: string, l: string): string => `这个 Space 已用 ${u}，上限 ${l}。`,
  T_FULL_NOTICE: (u: string, l: string): string => `这个 Space 已满（${u} / ${l}），删除一些内容后才能继续添加。`,
  T_ADD_BLOCKED: '这个 Space 已满，删除一些内容后才能继续添加。',
  T_OVERWRITE_BLOCKED: '这个 Space 已满，暂时不能再移动或修改，删除一些内容后可继续。',
  T_NO_ROOM: (r: string): string => `放不下：这个 Space 只剩 ${r}。`,
  T_OVER_CEILING_DELETE: '这个 Space 已超出上限，请删除整个节点或整段内容。',
  T_TIMELINE_FULL: '这个 Space 已满，无法继续添加。',
  T_3D_FULL: '这个 Space 已满，无法继续编辑。',
  T_RESYNC: '你刚才的改动超出了这个 Space 的大小上限，没有保存。',
  T_PROPOSAL_FULL: '这个 Space 已满，提案没有放进去。',
  T_PROPOSAL_NO_ROOM: (r: string): string => `放不下：这个 Space 只剩 ${r}，提案没有放进去。`,
  T_UPLOAD_FAILED: '上传失败',
  T_SPACE_FULL_REASON: '这个 Space 已满。',
  T_TEXT_NO_ROOM: (r: string): string => `文字没有写入：放不下，这个 Space 只剩 ${r}。`,
  T_TEXT_FULL: '文字没有写入：这个 Space 已满。',
} as const;
