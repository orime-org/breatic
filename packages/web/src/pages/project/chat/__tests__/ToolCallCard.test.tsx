// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a tool use is shown once the turn it belonged to is over.
 *
 * Two endings leave a tool with no result and they are not the same thing.
 * The tool can fail, or the user can stop the turn while it is still running,
 * and then nothing went wrong — it simply never finished. Storage keeps both
 * as `error`, because there is no third terminal state; which one it was
 * comes over as its own field.
 *
 * What the card shows is a translated line, never the reason itself. The
 * reason names hosts and statuses, and it does not leave the backend — the
 * user learns what happened from the assistant's reply, in its own words.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ToolCallCard } from '@web/pages/project/chat/ToolCallCard';
import type { ToolCall } from '@web/pages/project/chat/types';
import { FAILURE_LINES, t } from '@breatic/shared';

/**
 * A tool call in the shape the panel receives it.
 * @param over - The fields under test
 * @returns The call
 */
function call(over: Partial<ToolCall>): ToolCall {
  return { id: 'tc-1', name: 'web_search', args: {}, status: 'success', ...over };
}

/** A call the tool itself failed. */
const failed = {
  status: 'error',
  failureKind: 'tool_failed',
  failureKey: 'chat.tool.failure.unreachable',
} as const;

/** A call the user stopped mid-flight. */
const stopped = {
  status: 'error',
  failureKind: 'user_aborted',
  failureKey: 'chat.tool.unfinished',
} as const;

describe('ToolCallCard', () => {
  it('says a tool failed, in the reader’s own language', () => {
    render(<ToolCallCard toolCall={call(failed)} />);

    const shown = screen.getByTestId('tool-call-error').textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);
    // Translated, not the key itself: an untranslated key would render as
    // `chat.tool.failure.unreachable` and read as a bug to whoever saw it.
    expect(shown).not.toContain('chat.tool');
  });

  it('says the same thing for every way a tool can fail', () => {
    // The card answers one question -- did this step work -- and the reason it
    // did not is the model's to explain in its reply, where it can say which
    // page and which status. A line of its own per failure would be that many
    // half-answers to a question nobody asked the card.
    const lines = Object.values(FAILURE_LINES)
      .filter((line) => line !== FAILURE_LINES.stopped)
      .map((failureKey) => {
        const { unmount } = render(<ToolCallCard toolCall={call({ ...failed, failureKey })} />);
        const shown = screen.getByTestId('tool-call-error').textContent ?? '';
        unmount();
        return shown;
      });

    // At least two, or "they all say the same thing" claims nothing.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lines).size).toBe(1);
    expect(lines[0]).toBe(t(FAILURE_LINES.generic));
  });

  it('tells a stopped call apart from a failed one', () => {
    const { unmount } = render(<ToolCallCard toolCall={call(failed)} />);
    const failedLine = screen.getByTestId('tool-call-error').textContent ?? '';
    unmount();

    render(<ToolCallCard toolCall={call(stopped)} />);
    const stoppedLine = screen.getByTestId('tool-call-unfinished').textContent ?? '';

    expect(stoppedLine).not.toBe(failedLine);
    expect(stoppedLine).toBe(t(FAILURE_LINES.stopped));
  });

  it('does not call a tool the user stopped a failure', () => {
    // Showing this as a failure tells the user something broke when they are
    // the one who stopped it.
    render(<ToolCallCard toolCall={call(stopped)} />);

    expect(screen.queryByTestId('tool-call-error')).toBeNull();
    expect(screen.getByTestId('tool-call-unfinished')).toBeInTheDocument();
  });

  it('does not draw a stopped call with the failure icon either', () => {
    // The caption and the icon are two ways of saying the same thing. Fixing
    // only the words leaves the louder one still calling it a failure.
    const { container } = render(<ToolCallCard toolCall={call(stopped)} />);

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('unfinished');
    expect(container.querySelector('.text-status-error')).toBeNull();
  });

  it('does draw a real failure with the failure icon', () => {
    const { container } = render(<ToolCallCard toolCall={call(failed)} />);

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('error');
    expect(container.querySelector('.text-status-error')).not.toBeNull();
  });

  it('still calls it a failure when the ending came over without a line', () => {
    // A record written before this field existed, or one whose failure the
    // turn could not describe. `error` on its own is a failure — reading the
    // absence of a line as "the user stopped it" is what the old rule did,
    // and it turned every failure into somebody else's doing.
    render(<ToolCallCard toolCall={call({ status: 'error' })} />);

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('error');
  });

  it('still says something when no line came with the failure', () => {
    // What a turn still streaming looks like: the SDK's client assembled the
    // part and has no line of ours to put on it. A blank row under a failure
    // icon reads as a rendering bug, so the coarse line stands in.
    render(<ToolCallCard toolCall={call({ status: 'error' })} />);

    const shown = screen.getByTestId('tool-call-error').textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain('chat.tool');
  });

  it('calls a call the user stopped stopped, even mid-stream', () => {
    // A turn stopped while a tool was running leaves that part exactly where
    // it was — the SDK client pushes it to no end state — so the panel reads
    // it as `error` with nothing on it. Drawing that as a failure tells the
    // user something broke when they are the one who stopped it.
    render(
      <ToolCallCard toolCall={call({ status: 'error', failureKind: 'user_aborted' })} />,
    );

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('unfinished');
  });

  it('calls it stopped when the line is the only thing that says so', () => {
    // 这是用户按停止时最常走的那条路,而它只带得来两个字段里的一个。工具收到
    // 中止信号后自己抛出「用户停止了」,SDK 因此把这一格推到 output-error,线上
    // 只有一个 errorText 装那条行文案 —— 说明是哪一种结局的那个字段是回放时
    // 才从库里读出来的。图标只看那个字段,于是画成红色的失败,配着一句「已停止」。
    render(
      <ToolCallCard
        toolCall={call({ status: 'error', failureKey: FAILURE_LINES.stopped })}
      />,
    );

    const card = screen.getByTestId('tool-call-card');
    expect(card.getAttribute('data-status')).toBe('unfinished');
    expect(screen.getByTestId('tool-call-unfinished')).toBeDefined();
  });

  it('falls back to a stopped line only in the stopped branch', () => {
    // 两个分支各有自己的兜底句,而兜底正是没有 failureKey 时唯一决定显示哪句的
    // 东西。把两句对调,189 条前端用例一条都不红 —— 于是一次失败会写「已停止」、
    // 一次停止会写「执行错误」,而它们本来是相反的意思。
    render(<ToolCallCard toolCall={call({ status: 'error', failureKind: 'user_aborted' })} />);

    expect(screen.getByTestId('tool-call-unfinished').textContent).toBe(
      t(FAILURE_LINES.stopped),
    );
  });

  it('falls back to a failure line only in the failure branch', () => {
    render(<ToolCallCard toolCall={call({ status: 'error' })} />);

    expect(screen.getByTestId('tool-call-error').textContent).toBe(t(FAILURE_LINES.generic));
  });

  it('shows nothing extra for a tool that came back normally', () => {
    render(<ToolCallCard toolCall={call({ status: 'success', result: 'two links' })} />);

    expect(screen.queryByTestId('tool-call-error')).toBeNull();
    expect(screen.queryByTestId('tool-call-unfinished')).toBeNull();
  });
});
