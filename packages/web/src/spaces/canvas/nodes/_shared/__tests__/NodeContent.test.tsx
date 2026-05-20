import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodeContent } from '@/spaces/canvas/nodes/_shared/NodeContent';

describe('NodeContent', () => {
  it('renders placeholder when status=idle + no content', () => {
    render(
      <NodeContent
        status='idle'
        hasContent={false}
        placeholder={<div data-testid='ph'>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('ph')).toBeInTheDocument();
  });

  it('renders content when status=idle + hasContent', () => {
    render(
      <NodeContent
        status='idle'
        hasContent
        placeholder={<div>P</div>}
        content={<div data-testid='content'>C</div>}
      />,
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('renders skeleton when status=handling regardless of content', () => {
    render(
      <NodeContent
        status='handling'
        hasContent
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });

  it('renders the error message when status=error', () => {
    render(
      <NodeContent
        status='error'
        errorMessage='Oh no'
        hasContent
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent('Oh no');
  });

  it('error block falls back to a generic message when no errorMessage', () => {
    render(
      <NodeContent
        status='error'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent(
      /something went wrong/i,
    );
  });
});
