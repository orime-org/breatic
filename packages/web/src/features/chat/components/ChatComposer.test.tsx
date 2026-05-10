// @vitest-environment jsdom

/**
 * F12 — `ChatComposer` v13 input box tests.
 *
 * Mocks the icon dictionary + i18n so the test renders without
 * the full UI runtime; asserts the visible behaviors callers
 * depend on:
 *
 *   - Cmd / Ctrl + Enter sends; plain Enter does not
 *   - Empty / whitespace-only doesn't fire onSend
 *   - Send button disabled when nothing to send
 *   - Chips render with name + remove button (when handler given)
 *   - Empty state hint shown when chips.length === 0
 *   - Pick-from-canvas + Skill button click handlers fire
 *   - `disabled` blocks send + greys out textarea
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChatComposer, { type ChatChip } from './ChatComposer';

vi.mock('@/ui/icon', () => ({
  Icon: ({ name }: { name: string }) =>
    React.createElement('span', { 'data-icon': name }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
  }),
}));

vi.mock('@/utils/classnames', () => ({
  cn: (...args: unknown[]) =>
    args
      .flat()
      .filter((v) => typeof v === 'string')
      .join(' '),
}));

afterEach(() => cleanup());

const noop = () => {};

const sampleChip = (id: string, name: string): ChatChip => ({
  id,
  nodeId: 'node-' + id,
  kind: 'image',
  name,
});

describe('ChatComposer — render', () => {
  it('shows the chips-empty hint when chips.length === 0', () => {
    render(
      <ChatComposer value='' onChange={noop} chips={[]} />,
    );
    expect(
      screen.getByText('点 ← 从画布选取节点添加为引用'),
    ).toBeTruthy();
  });

  it('renders chips with names + remove buttons when chips and handler are provided', () => {
    render(
      <ChatComposer
        value=''
        onChange={noop}
        chips={[sampleChip('c1', 'Photo'), sampleChip('c2', 'Mountain')]}
        onRemoveChip={noop}
      />,
    );
    expect(screen.getByText('Photo')).toBeTruthy();
    expect(screen.getByText('Mountain')).toBeTruthy();
    expect(screen.getAllByTitle('移除').length).toBe(2);
  });

  it('hides chip remove buttons when no onRemoveChip handler is given', () => {
    render(
      <ChatComposer
        value=''
        onChange={noop}
        chips={[sampleChip('c1', 'Photo')]}
      />,
    );
    expect(screen.queryByTitle('移除')).toBeNull();
  });

  it('uses the chips-aware placeholder when at least one chip is present', () => {
    render(
      <ChatComposer
        value=''
        onChange={noop}
        chips={[sampleChip('c1', 'Photo')]}
      />,
    );
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.placeholder).toBe('描述你想做什么(用 @ 引用上方 chips)…');
  });

  it('uses the empty-state placeholder when chips is empty', () => {
    render(<ChatComposer value='' onChange={noop} chips={[]} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.placeholder).toBe('输入消息…');
  });
});

describe('ChatComposer — interactions', () => {
  it('fires onChange when typing', () => {
    const onChange = vi.fn();
    render(<ChatComposer value='' onChange={onChange} chips={[]} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledWith('hi');
  });

  it('Cmd+Enter sends with trimmed text + chips', () => {
    const onSend = vi.fn();
    const chips = [sampleChip('c1', 'Photo')];
    render(
      <ChatComposer
        value='  hello  '
        onChange={noop}
        chips={chips}
        onSend={onSend}
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSend).toHaveBeenCalledWith('hello', chips);
  });

  it('Ctrl+Enter also sends (Windows / Linux)', () => {
    const onSend = vi.fn();
    render(
      <ChatComposer value='hello' onChange={noop} chips={[]} onSend={onSend} />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      ctrlKey: true,
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('plain Enter does NOT send (Cmd/Ctrl modifier required)', () => {
    const onSend = vi.fn();
    render(
      <ChatComposer value='hello' onChange={noop} chips={[]} onSend={onSend} />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Cmd+Enter on whitespace-only does not send', () => {
    const onSend = vi.fn();
    // Use a JS expression so `\n` is the real newline character
    // (a JSX attribute string would pass the literal backslash + n
    // pair, defeating the whitespace check).
    render(
      <ChatComposer
        value={'   \n   '}
        onChange={noop}
        chips={[]}
        onSend={onSend}
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Send button click sends with trimmed text', () => {
    const onSend = vi.fn();
    render(
      <ChatComposer value='  hi  ' onChange={noop} chips={[]} onSend={onSend} />,
    );
    fireEvent.click(screen.getByLabelText('发送'));
    expect(onSend).toHaveBeenCalledWith('hi', []);
  });

  it('Send button is disabled when text is empty', () => {
    render(<ChatComposer value='' onChange={noop} chips={[]} />);
    expect(
      (screen.getByLabelText('发送') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('disabled prop blocks send and greys out the textarea', () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        value='hello'
        onChange={noop}
        chips={[]}
        onSend={onSend}
        disabled
      />,
    );
    expect(
      (screen.getByLabelText('发送') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('textbox') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('pick-from-canvas button fires onEnterSelectMode', () => {
    const onEnterSelectMode = vi.fn();
    render(
      <ChatComposer
        value=''
        onChange={noop}
        chips={[]}
        onEnterSelectMode={onEnterSelectMode}
      />,
    );
    fireEvent.click(screen.getByTitle('从画布选取节点(Esc 退出选择模式)'));
    expect(onEnterSelectMode).toHaveBeenCalledTimes(1);
  });

  it('Skill button fires onPickSkill', () => {
    const onPickSkill = vi.fn();
    render(
      <ChatComposer
        value=''
        onChange={noop}
        chips={[]}
        onPickSkill={onPickSkill}
      />,
    );
    fireEvent.click(screen.getByTitle('选择 Skill'));
    expect(onPickSkill).toHaveBeenCalledTimes(1);
  });

  it('chip remove button fires onRemoveChip with the chip id', () => {
    const onRemoveChip = vi.fn();
    render(
      <ChatComposer
        value=''
        onChange={noop}
        chips={[sampleChip('c1', 'Photo')]}
        onRemoveChip={onRemoveChip}
      />,
    );
    fireEvent.click(screen.getByTitle('移除'));
    expect(onRemoveChip).toHaveBeenCalledWith('c1');
  });
});
