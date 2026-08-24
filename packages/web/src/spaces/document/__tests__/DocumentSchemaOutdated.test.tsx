// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 拦截时取代整个编辑区的那个面板（验收 16、17）。
 *
 * **验收 19 不在这儿**：它要的是「工具栏和正文都不在、布局跟视觉稿一致、
 * 明暗两套」，这三件都得看渲染出来的样子，这个文件一条都没断言。它靠真机
 * 跑，记录在设计文档 §10。
 *
 * 这是承诺外的收场方式：说清现状、说清刷新的代价、把刷新这个动作交给用户。
 * **它只有一个形态** —— 组件不接受任何决定形态的参数，所以「按触发条件说
 * 不同的话」「有没有进行中的操作显示不同的东西」这类分支在类型上就不存在。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@breatic/shared';

import { DocumentSchemaOutdated } from '@web/spaces/document/DocumentSchemaOutdated';

const RISK_UPLOADS = 'spaces.document.schemaOutdated.riskUploads';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('三件内容都在', () => {
  it('说清现状', () => {
    render(<DocumentSchemaOutdated publishedAt={null} />);
    expect(screen.getByTestId('document-schema-outdated')).toBeInTheDocument();
    expect(screen.getByTestId('document-schema-outdated-headline')).toHaveTextContent(
      /\S/,
    );
  });

  it('讲了那条真实的风险：上传会被中断', () => {
    // 断言的是**这条文案真的渲染出来了**，不是「这一段够长」。长度断言看着
    // 像在验内容，其实删掉任意一句都还过得去 —— 实测过。
    //
    // 这里原本还钉着「撤销和重做记录会清空」。**那句话已经删掉了，因为它是
    // 假的**：拦截成立那一刻编辑器已经被销毁，撤销栈跟着编辑器一起没了，
    // 面板出现在屏幕上时它早就不在。把一件已经发生的事说成刷新的代价，会让
    // 人去找一个不存在的东西。
    expect(t(RISK_UPLOADS)).not.toBe(RISK_UPLOADS); // key 不存在时 t() 原样返回它

    render(<DocumentSchemaOutdated publishedAt={null} />);
    const risks = screen.getByTestId('document-schema-outdated-risks');
    expect(risks).toHaveTextContent(t(RISK_UPLOADS));
  });

  it('给一颗刷新按钮，点了就刷新页面', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    render(<DocumentSchemaOutdated publishedAt={null} />);
    await userEvent.click(screen.getByTestId('document-schema-outdated-refresh'));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('服务器那份是什么时候发布的', () => {
  it('知道就说出来', () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(<DocumentSchemaOutdated publishedAt={anHourAgo} />);
    expect(screen.getByTestId('document-schema-outdated-published')).toBeInTheDocument();
  });

  it('不知道就不说 —— 不编一个出来', () => {
    render(<DocumentSchemaOutdated publishedAt={null} />);
    expect(
      screen.queryByTestId('document-schema-outdated-published'),
    ).not.toBeInTheDocument();
  });

  it('时间串是坏的也不崩', () => {
    render(<DocumentSchemaOutdated publishedAt='not a date' />);
    expect(screen.getByTestId('document-schema-outdated')).toBeInTheDocument();
  });
});

describe('只有一个形态', () => {
  it('知不知道发布时间，三件内容都一样在', () => {
    const { rerender } = render(<DocumentSchemaOutdated publishedAt={null} />);
    const withoutTime = {
      headline: screen.getByTestId('document-schema-outdated-headline').textContent,
      risks: screen.getByTestId('document-schema-outdated-risks').textContent,
      action: screen.getByTestId('document-schema-outdated-refresh').textContent,
    };

    rerender(<DocumentSchemaOutdated publishedAt={new Date().toISOString()} />);

    expect(
      screen.getByTestId('document-schema-outdated-headline').textContent,
    ).toBe(withoutTime.headline);
    expect(screen.getByTestId('document-schema-outdated-risks').textContent).toBe(
      withoutTime.risks,
    );
    expect(
      screen.getByTestId('document-schema-outdated-refresh').textContent,
    ).toBe(withoutTime.action);
  });
});

describe('可访问性', () => {
  it('是一条 alert —— 它取代了用户正要用的东西，屏幕阅读器要立刻知道', () => {
    render(<DocumentSchemaOutdated publishedAt={null} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('刷新是一个真的按钮，键盘够得到', () => {
    render(<DocumentSchemaOutdated publishedAt={null} />);
    const button = screen.getByTestId('document-schema-outdated-refresh');
    expect(button.tagName.toLowerCase()).toBe('button');
    expect(button).toHaveAttribute('type', 'button');
  });
});
