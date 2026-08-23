// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 拦截的作用域：它盖住这个 project 里**每一个** document space，而画布和
 * 时间轴一点不受影响（验收 15、18）。
 *
 * 这两件事是同一个理由的两面：这份 schema 是 **document 的** schema。它跟
 * 服务器对不上，说明 document 编辑器不该再用——而那句话对这个页面里每个
 * document space 都成立（它们跑的是同一份前端代码），对画布则完全不成立。
 *
 * 「别的 tab 照常能切」不是顺带的宽松，是面板上那条风险提示成立的前提：
 * 它让用户先切到画布确认上传完了没，再回来刷新。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
} from '@breatic/shared';

import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';
import { docName, getDoc } from '@web/data/yjs/manager';

const PROJECT = 'p-intercept';

afterEach(() => {
  // 把发布过的那份清掉，免得漏进别的用例。
  getDoc(docName.projectMeta(PROJECT)).getMap(DOCUMENT_SCHEMA_META_KEY).clear();
});

/**
 * 让服务器发布一份跟本 build 不一样的清单。
 */
function publishDifferentSchema(): void {
  const meta = getDoc(docName.projectMeta(PROJECT));
  meta.transact(() => {
    const map = meta.getMap(DOCUMENT_SCHEMA_META_KEY);
    map.set('version', 'another-build');
    map.set('nodes', DOCUMENT_SCHEMA.nodes);
    map.set('marks', DOCUMENT_SCHEMA.marks);
    map.set('publishedAt', '2026-08-13T06:20:00.000Z');
  });
}

/**
 * Mounts the outlet with a query client around it, the way the real app does
 * (`App.tsx` wraps everything in one).
 *
 * Takes the element rather than its props, so every call site keeps writing
 * the props it means and this only owns the wrapper. A fresh client per mount
 * keeps one test's cached catalog out of the next one's gate — a constraint
 * that lives in one place here instead of being restated at every call.
 * @param element - The outlet to mount, with whatever props the case needs.
 * @returns The render result.
 */
function renderOutlet(element: React.JSX.Element): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      {element}
    </QueryClientProvider>,
  );
}

describe('服务器那份跟我不一样时', () => {
  it('document space 被拦下来，出的是那个面板', () => {
    publishDifferentSchema();

    renderOutlet(<SpaceOutlet projectId={PROJECT} spaceId='s1' type='document' />);

    expect(screen.getByTestId('document-schema-outdated')).toBeInTheDocument();
  });

  it('replaces the editor outright: no body, no command entry', () => {
    // 「面板出现」跟「编辑区没了」是两件事：面板出现在编辑区上方也满足前者，
    // Overlaying it would leave the body there and the entry clickable. This
    // pins that it does not.
    //
    // This named `document-toolbar` until #129 removed the toolbar, which left
    // the assertion vacuous. The editing chrome is now the entry at the body's
    // top right corner, so that is what it names.
    publishDifferentSchema();

    renderOutlet(<SpaceOutlet projectId={PROJECT} spaceId='s1' type='document' />);

    expect(screen.getByTestId('document-schema-outdated')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-doc-menu-trigger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('document-editor-content')).not.toBeInTheDocument();
    // 外壳（`document-space`）留着是对的：面板就装在它里面，四个分支共用它。
  });

  it('同一个 project 里的第二个 document space 一样被拦', () => {
    publishDifferentSchema();

    renderOutlet(<SpaceOutlet projectId={PROJECT} spaceId='s2' type='document' />);

    expect(screen.getByTestId('document-schema-outdated')).toBeInTheDocument();
  });

  it('画布照常——这份 schema 只管 document', () => {
    publishDifferentSchema();

    renderOutlet(<SpaceOutlet projectId={PROJECT} spaceId='s3' type='canvas' />);

    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
    expect(
      screen.queryByTestId('document-schema-outdated'),
    ).not.toBeInTheDocument();
  });

  it('时间轴也照常', () => {
    publishDifferentSchema();

    renderOutlet(<SpaceOutlet projectId={PROJECT} spaceId='s4' type='timeline' />);

    expect(screen.getByTestId('timeline-space-empty')).toBeInTheDocument();
  });
});

describe('服务器那份跟我一样时', () => {
  it('document space 照常，不出面板', () => {
    const meta = getDoc(docName.projectMeta(PROJECT));
    meta.transact(() => {
      const map = meta.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set('version', DOCUMENT_SCHEMA_VERSION);
      map.set('nodes', DOCUMENT_SCHEMA.nodes);
      map.set('marks', DOCUMENT_SCHEMA.marks);
      map.set('publishedAt', '2026-08-13T06:20:00.000Z');
    });

    renderOutlet(<SpaceOutlet projectId={PROJECT} spaceId='s5' type='document' />);

    expect(
      screen.queryByTestId('document-schema-outdated'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('document-space')).toBeInTheDocument();
  });
});
