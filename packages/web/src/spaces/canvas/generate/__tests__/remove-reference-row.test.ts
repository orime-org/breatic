// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 轨道行的 ✕ —— 两个生成面板共用的那一个动作。
 *
 * 轨道有两种行，✕ 在两种上意思不同：连线行要断的是连接，裁剪行要删的是节点上
 * 存的那份副本、还要补一条资产删除登记。这套判断本来只写在图片面板里，#1978
 * 视频面板接上聚焦时被逐字复制了一遍（27 行，剥注释后零差异），所以收到这里。
 *
 * 登记那一半此前两个面板都没有测试，`assetsApi` 也没被 mock —— 点 ✕ 的测试会
 * 真发一次 HTTP 请求，成败都被静默 catch 吞掉。收进函数之后它才测得了。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CanvasNodeFields, FocusImage } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  addNodeFocusImage,
  readCanvasGraph,
} from '@web/data/yjs/canvas-space';
import { focusRefId } from '@web/spaces/canvas/generate/derive-references';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { removeReferenceRow } from '@web/spaces/canvas/generate/remove-reference-row';
import { assetsApi } from '@web/data/api/assets';

vi.mock('@web/data/api/assets', () => ({
  assetsApi: { reportDeleted: vi.fn(() => Promise.resolve()) },
}));

const PID = 'p1';
const SID = 's1';
const NODE = 'gen';

/** A stored crop with a distinct asset URL. */
const crop = (id: string, url = `https://cdn/${id}.png`): FocusImage => ({
  id,
  url,
  name: `Crop ${id}`,
  width: 100,
  height: 100,
});

/**
 * The minimal generative node the writes target.
 * @param id - Node id.
 * @returns A complete node fixture.
 */
function genNode(id: string): CanvasNodeFields {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      name: 'G',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      state: 'idle',
      attachments: [],
    },
  };
}

/**
 * A rail row for a stored crop, the way `focusToRailItem` builds one.
 * @param c - The stored crop.
 * @returns The crop's rail row.
 */
function cropRow(c: FocusImage): ReferenceRailItem {
  return {
    refId: focusRefId(c.id),
    sourceNodeId: focusRefId(c.id),
    sourceNodeType: 'image',
    sourceNodeName: c.name,
    thumbnail: c.url,
    mediaUrl: c.url,
    focus: true,
  };
}

/**
 * Reads the crops still stored on the target node.
 * @returns The node's `focusImages`, or an empty array.
 */
function storedCrops(): unknown[] {
  const node = readCanvasGraph(PID, SID).nodes.find((n) => n.id === NODE);
  const data = node?.data as { focusImages?: unknown[] } | undefined;
  return data?.focusImages ?? [];
}

describe('removeReferenceRow', () => {
  beforeEach(() => {
    _resetForTests();
    vi.mocked(assetsApi.reportDeleted).mockClear();
    getDoc(docName.canvasSpace(PID, SID));
    addNode(PID, SID, genNode(NODE));
  });

  it('裁剪行的 ✕ 把那条裁剪从节点上删掉', () => {
    const c = crop('c1');
    addNodeFocusImage(PID, SID, NODE, c);
    expect(storedCrops()).toHaveLength(1);

    removeReferenceRow({
      item: cropRow(c),
      projectId: PID,
      spaceId: SID,
      nodeId: NODE,
    });

    expect(storedCrops()).toHaveLength(0);
  });

  it('删成功之后补一条资产删除登记，写明是哪张图', async () => {
    const c = crop('c1');
    addNodeFocusImage(PID, SID, NODE, c);

    removeReferenceRow({
      item: cropRow(c),
      projectId: PID,
      spaceId: SID,
      nodeId: NODE,
    });

    await vi.waitFor(() => {
      expect(assetsApi.reportDeleted).toHaveBeenCalledWith({
        projectId: PID,
        entries: [{ fileUrl: c.url, kind: 'image', nodeId: NODE, spaceId: SID }],
      });
    });
  });

  it('那条裁剪已经不在了就什么都不做 —— 双击、或者远端先删了都会走到这里', () => {
    // 节点上没有这条裁剪：删除是空操作，再补一条登记就成了重复的审计行。
    removeReferenceRow({
      item: cropRow(crop('ghost')),
      projectId: PID,
      spaceId: SID,
      nodeId: NODE,
    });

    expect(assetsApi.reportDeleted).not.toHaveBeenCalled();
  });

  it('同一张图还被别处引用着就不登记 —— 去重让两条裁剪共用一个 URL', () => {
    const shared = 'https://cdn/shared.png';
    const a = crop('c1', shared);
    const b = crop('c2', shared);
    addNodeFocusImage(PID, SID, NODE, a);
    addNodeFocusImage(PID, SID, NODE, b);

    removeReferenceRow({
      item: cropRow(a),
      projectId: PID,
      spaceId: SID,
      nodeId: NODE,
    });

    expect(storedCrops()).toHaveLength(1);
    expect(assetsApi.reportDeleted).not.toHaveBeenCalled();
  });

  it('连线行的 ✕ 断的是那条边，不碰节点上的裁剪', () => {
    const c = crop('c1');
    addNodeFocusImage(PID, SID, NODE, c);
    const edgeRow: ReferenceRailItem = {
      refId: 'e1',
      sourceNodeId: 'src',
      sourceNodeType: 'image',
      sourceNodeName: 'Src',
      thumbnail: 'https://cdn/src.png',
      mediaUrl: 'https://cdn/src.png',
    };

    removeReferenceRow({
      item: edgeRow,
      projectId: PID,
      spaceId: SID,
      nodeId: NODE,
    });

    // 裁剪没被动过，也没有人替它登记删除。
    expect(storedCrops()).toHaveLength(1);
    expect(assetsApi.reportDeleted).not.toHaveBeenCalled();
  });

  it('伪造成 focus: 开头的边 id 不会被当成裁剪 —— 边 id 是协作数据，不可信', () => {
    // 路由只认行自己的 focus 标记，不认 id 长什么样：一条 refId 写成
    // `focus:c1` 的边如果被当成裁剪，点它的 ✕ 就会删掉别人的那张图。
    const c = crop('c1');
    addNodeFocusImage(PID, SID, NODE, c);
    const spoofed: ReferenceRailItem = {
      refId: focusRefId('c1'),
      sourceNodeId: 'src',
      sourceNodeType: 'image',
      sourceNodeName: 'Src',
      thumbnail: 'https://cdn/src.png',
      mediaUrl: 'https://cdn/src.png',
    };

    removeReferenceRow({
      item: spoofed,
      projectId: PID,
      spaceId: SID,
      nodeId: NODE,
    });

    expect(storedCrops()).toHaveLength(1);
    expect(assetsApi.reportDeleted).not.toHaveBeenCalled();
  });
});
