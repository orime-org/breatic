// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import { ITEM_SLUG_BOUNDS } from '@web/pages/studio/container/dialogs/slug-util';

const BASE = {
  id: 'demo-slug',
  label: 'Slug',
  value: '',
  onChange: () => {},
  bounds: ITEM_SLUG_BOUNDS,
  helper: 'Part of the URL.',
} as const;

/**
 * The one hint line under the input.
 * @returns The hint element.
 */
function hint(): HTMLElement {
  return screen.getByTestId('demo-slug-hint');
}

describe('SlugField hint line', () => {
  it('shows the muted helper while the field is empty', () => {
    render(<SlugField {...BASE} check={{ state: 'empty' }} />);
    expect(hint()).toHaveTextContent('Part of the URL.');
    expect(hint()).toHaveClass('text-muted-foreground');
    expect(screen.getByLabelText('Slug')).toHaveAttribute(
      'aria-describedby',
      'demo-slug-hint',
    );
    expect(screen.getByLabelText('Slug')).toHaveAttribute('aria-invalid', 'false');
  });

  it('replaces the helper with a muted checking line while a check is pending', () => {
    render(<SlugField {...BASE} value='my-pro' check={{ state: 'checking' }} />);
    expect(hint()).toHaveTextContent('Checking…');
    expect(hint()).toHaveClass('text-muted-foreground');
    expect(screen.queryByText('Part of the URL.')).not.toBeInTheDocument();
  });

  it('replaces the helper with the red reason when the slug is rejected', () => {
    render(
      <SlugField
        {...BASE}
        value='1-project'
        check={{ state: 'invalid', reason: 'format' }}
      />,
    );
    expect(hint()).toHaveTextContent(
      'Start with a lowercase letter; use only lowercase letters, numbers and single hyphens, not at the end.',
    );
    expect(hint()).toHaveClass('text-status-error-foreground');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Part of the URL.')).not.toBeInTheDocument();
  });

  it('fills the length bounds into the length reason', () => {
    render(
      <SlugField
        {...BASE}
        value='abc'
        check={{ state: 'invalid', reason: 'length' }}
      />,
    );
    expect(hint()).toHaveTextContent('6');
    expect(hint()).toHaveTextContent('50');
  });

  it('shows a green available line when the slug passes', () => {
    render(<SlugField {...BASE} value='my-project' check={{ state: 'valid' }} />);
    expect(hint()).toHaveTextContent('Slug is available');
    expect(hint()).toHaveClass('text-status-success-foreground');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('aria-invalid', 'false');
  });
});
