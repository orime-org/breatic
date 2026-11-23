// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1423 design 6.6: an insert card anchored after an
 * empty formula block names the block by its kind, as it does an image.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DocumentProposal } from '@breatic/shared';

import { DocumentProposalCard } from '@web/pages/project/chat/DocumentProposalCard';

vi.mock('@web/spaces/document/document-editor-cache', () => ({ peekDocumentEditor: () => undefined }));

const PROJECT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  cleanup();
});

describe('an insert card after an empty formula block', () => {
  it('names the block Formula', () => {
    const proposal: DocumentProposal = {
      proposalId: '33333333-3333-4333-8333-333333333333',
      spaceId: '44444444-4444-4444-8444-444444444444',
      spaceName: 'Storyboard',
      kind: 'insert',
      blockId: 'b2',
      body: 'She waits.',
      title: 'Add a line',
      heading: 'Scene 2',
      original: '\n',
      blockType: 'mathBlock',
      lossy: false,
    };
    render(
      <MemoryRouter initialEntries={[`/project/demo-${PROJECT}`]}>
        <Routes>
          <Route path='/project/:projectId' element={<DocumentProposalCard proposal={proposal} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('document-proposal-anchor').textContent).toBe('Formula');
  });
});
