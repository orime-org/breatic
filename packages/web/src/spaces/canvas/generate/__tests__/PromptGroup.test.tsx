// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A panel's prompts with one open at a time (#1201): the open one shows its
 * box, every other one is a single row naming it and showing its first line,
 * and a box is never unmounted, so what it holds stays.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PromptGroup, type PromptGroupItem } from '@web/spaces/canvas/generate/PromptGroup';

/**
 * One prompt row.
 * @param id - Its id.
 * @param over - Fields to change.
 * @returns The row.
 */
function item(id: string, over: Partial<PromptGroupItem> = {}): PromptGroupItem {
  return {
    id,
    name: `Name ${id}`,
    preview: `First line of ${id}`,
    placeholder: `Describe ${id}`,
    editor: <textarea data-testid={`box-${id}`} aria-label={`box ${id}`} />,
    ...over,
  };
}

describe('the prompt group', () => {
  it('shows only the open box and keeps the others mounted, hidden', () => {
    render(<PromptGroup items={[item('a'), item('b'), item('c')]} value='b' onValueChange={vi.fn()} />);

    expect(screen.getByTestId('box-b')).toBeVisible();
    expect(screen.getByTestId('box-a')).not.toBeVisible();
    expect(screen.getByTestId('box-c')).not.toBeVisible();
  });

  it('opens a collapsed row when its row is clicked', () => {
    const onValueChange = vi.fn();
    render(<PromptGroup items={[item('a'), item('b')]} value='a' onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Name b/ }));

    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('keeps the open row open when its own row is clicked', () => {
    const onValueChange = vi.fn();
    render(<PromptGroup items={[item('a'), item('b')]} value='a' onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Name a/ }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('shows a collapsed row its first line, the placeholder when it is empty, and the open row neither', () => {
    render(
      <PromptGroup
        items={[item('a'), item('b'), item('c', { preview: '' })]}
        value='a'
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Name b/ })).toHaveTextContent('First line of b');
    expect(screen.getByRole('button', { name: /Name c/ })).toHaveTextContent('Describe c');
    expect(screen.getByRole('button', { name: /Name a/ })).not.toHaveTextContent('First line of a');
  });

  it('draws a lone prompt with its name as today, not as a row to click', () => {
    render(<PromptGroup items={[item('a')]} value='a' onValueChange={vi.fn()} />);

    expect(screen.getByText('Name a')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('box-a')).toBeVisible();
  });

  it('draws a lone prompt with no name as a bare box', () => {
    const { container } = render(
      <PromptGroup items={[item('a', { name: undefined })]} value='a' onValueChange={vi.fn()} />,
    );

    expect(screen.getByTestId('box-a')).toBeVisible();
    expect(container).not.toHaveTextContent('First line of a');
  });

  it('keeps the first box mounted when a second prompt comes and goes', () => {
    const mounts = vi.fn();
    /**
     * A box that counts its mounts.
     * @returns The box.
     */
    function Counted(): React.JSX.Element {
      React.useEffect(() => mounts(), []);
      return <textarea data-testid='counted' />;
    }
    const first = item('a', { editor: <Counted /> });
    const { rerender } = render(<PromptGroup items={[first]} value='a' onValueChange={vi.fn()} />);
    rerender(<PromptGroup items={[first, item('b')]} value='a' onValueChange={vi.fn()} />);
    rerender(<PromptGroup items={[first]} value='a' onValueChange={vi.fn()} />);

    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('leaves the controls beside a name to do their own work', () => {
    const onValueChange = vi.fn();
    const onControl = vi.fn();
    render(
      <PromptGroup
        items={[item('a'), item('b', { controls: <button type='button' onClick={onControl}>Remove b</button> })]}
        value='a'
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove b' }));

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
