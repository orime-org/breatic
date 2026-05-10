// @vitest-environment jsdom

/**
 * F13 — `AgentToolMessage` dispatcher + `AgentChoicePicker` /
 * `AgentSearchResultsGrid` / `AgentCanvasActionButton` invariants.
 *
 * One file because the three tools share the same mocks
 * (Icon / i18n / cn) and the dispatcher is what most consumers
 * touch — testing them together keeps the reader's eye on the
 * full chat-message rendering surface.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AgentToolMessage from './AgentToolMessage';
import type { AgentToolCall } from './agent-tool-types';

vi.mock('@/ui/icon', () => ({
  Icon: ({ name }: { name: string }) =>
    React.createElement('span', { 'data-icon': name }),
}));

vi.mock('@/utils/classnames', () => ({
  cn: (...args: unknown[]) =>
    args
      .flat()
      .filter((v) => typeof v === 'string')
      .join(' '),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _k: string,
      opts?: { defaultValue?: string; count?: number },
    ) => {
      const dv = opts?.defaultValue ?? _k;
      if (typeof opts?.count === 'number') {
        return dv.replace('{{count}}', String(opts.count));
      }
      return dv;
    },
  }),
}));

afterEach(() => cleanup());

const askChoiceCall: AgentToolCall = {
  name: 'ask_user_choice',
  args: {
    question: '哪个色调更接近?',
    choices: [
      { id: 'a', label: '霓虹紫粉', description: '高饱和' },
      { id: 'b', label: '雨夜蓝绿', description: '低饱和' },
    ],
  },
};

const searchResultsCall: AgentToolCall = {
  name: 'show_search_results',
  args: {
    images: [
      { url: '#', title: 'Wong Kar-wai', source: 'pinterest' },
      { url: 'https://example.com/img.png', title: 'Tokyo Rain', source: 'unsplash' },
    ],
  },
};

const proposeActionCall: AgentToolCall = {
  name: 'propose_canvas_action',
  args: {
    action: 'create_nodes',
    rationale: '3 个分镜起点',
    nodes: [
      { type: 'image', label: '分镜 1' },
      { type: 'image', label: '分镜 2' },
      { type: 'image', label: '分镜 3' },
    ],
  },
};

describe('AgentToolMessage — dispatcher', () => {
  it('renders ChoicePicker for ask_user_choice', () => {
    render(<AgentToolMessage toolCall={askChoiceCall} />);
    expect(screen.getByText('ask_user_choice')).toBeTruthy();
    expect(screen.getByText('哪个色调更接近?')).toBeTruthy();
  });

  it('renders SearchResultsGrid for show_search_results', () => {
    render(<AgentToolMessage toolCall={searchResultsCall} />);
    expect(screen.getByText('show_search_results')).toBeTruthy();
    expect(screen.getByText('Tokyo Rain')).toBeTruthy();
  });

  it('renders CanvasActionButton for propose_canvas_action', () => {
    render(<AgentToolMessage toolCall={proposeActionCall} />);
    expect(screen.getByText('propose_canvas_action')).toBeTruthy();
    expect(screen.getByText('3 个分镜起点')).toBeTruthy();
  });
});

describe('AgentChoicePicker (via dispatcher)', () => {
  it('lists every choice with label + description', () => {
    render(<AgentToolMessage toolCall={askChoiceCall} />);
    expect(screen.getByText('霓虹紫粉')).toBeTruthy();
    expect(screen.getByText('高饱和')).toBeTruthy();
    expect(screen.getByText('雨夜蓝绿')).toBeTruthy();
    expect(screen.getByText('低饱和')).toBeTruthy();
  });

  it('fires onSelectChoice with the picked option when no prior selection', () => {
    const onSelect = vi.fn();
    render(
      <AgentToolMessage
        toolCall={askChoiceCall}
        onSelectChoice={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('雨夜蓝绿'));
    expect(onSelect).toHaveBeenCalledWith({
      id: 'b',
      label: '雨夜蓝绿',
      description: '低饱和',
    });
  });

  it('locks once selectedChoiceId is set: unselected buttons are disabled, click is a no-op', () => {
    const onSelect = vi.fn();
    render(
      <AgentToolMessage
        toolCall={askChoiceCall}
        selectedChoiceId='a'
        onSelectChoice={onSelect}
      />,
    );
    const lockedNote = screen.getByText('已选定,无法更改');
    expect(lockedNote).toBeTruthy();
    // The unselected button should be disabled.
    const otherBtn = screen.getByText('雨夜蓝绿').closest('button')!;
    expect((otherBtn as HTMLButtonElement).disabled).toBe(true);
    // Clicking the already-selected option should NOT re-fire onSelect.
    fireEvent.click(screen.getByText('霓虹紫粉'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the selected button with aria-pressed=true', () => {
    render(
      <AgentToolMessage toolCall={askChoiceCall} selectedChoiceId='a' />,
    );
    const selectedBtn = screen.getByText('霓虹紫粉').closest('button')!;
    expect(selectedBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('AgentSearchResultsGrid (via dispatcher)', () => {
  it('shows hit count in the header', () => {
    render(<AgentToolMessage toolCall={searchResultsCall} />);
    expect(screen.getByText('2 张参考图')).toBeTruthy();
  });

  it('uses a placeholder div for # / empty urls and an <img> for real urls', () => {
    const { container } = render(
      <AgentToolMessage toolCall={searchResultsCall} />,
    );
    // Real url → <img>
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/img.png');
  });

  it('hides Add-to-Space button when no handler is given', () => {
    render(<AgentToolMessage toolCall={searchResultsCall} />);
    expect(screen.queryByLabelText('添加到 Space')).toBeNull();
  });

  it('fires onAddSearchHit with the hit when the button is clicked', () => {
    const onAdd = vi.fn();
    render(
      <AgentToolMessage
        toolCall={searchResultsCall}
        onAddSearchHit={onAdd}
      />,
    );
    const buttons = screen.getAllByLabelText('添加到 Space');
    fireEvent.click(buttons[0]);
    expect(onAdd).toHaveBeenCalledWith({
      url: '#',
      title: 'Wong Kar-wai',
      source: 'pinterest',
    });
  });
});

describe('AgentCanvasActionButton (via dispatcher)', () => {
  it('lists the proposed nodes and the rationale', () => {
    render(<AgentToolMessage toolCall={proposeActionCall} />);
    expect(screen.getByText('3 个分镜起点')).toBeTruthy();
    expect(screen.getByText('分镜 1')).toBeTruthy();
    expect(screen.getByText('分镜 2')).toBeTruthy();
    expect(screen.getByText('分镜 3')).toBeTruthy();
  });

  it('shows the count in both the header tag and the apply button', () => {
    render(<AgentToolMessage toolCall={proposeActionCall} />);
    expect(screen.getByText('create_nodes · 3 节点')).toBeTruthy();
    expect(screen.getByText('加到画布(3 节点)')).toBeTruthy();
  });

  it('fires onApplyCanvasAction when not yet applied', () => {
    const onApply = vi.fn();
    render(
      <AgentToolMessage
        toolCall={proposeActionCall}
        onApplyCanvasAction={onApply}
      />,
    );
    fireEvent.click(screen.getByText('加到画布(3 节点)'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('flips to "已加到画布" + disabled when applied=true', () => {
    const onApply = vi.fn();
    render(
      <AgentToolMessage
        toolCall={proposeActionCall}
        applied
        onApplyCanvasAction={onApply}
      />,
    );
    expect(screen.getByText('已加到画布')).toBeTruthy();
    const appliedBtn = screen.getByText('已加到画布').closest('button')!;
    expect((appliedBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(appliedBtn);
    expect(onApply).not.toHaveBeenCalled();
  });
});
