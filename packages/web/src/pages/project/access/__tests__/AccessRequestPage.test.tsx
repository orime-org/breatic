import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import AccessRequestPage from '@/pages/project/access/AccessRequestPage';
import { ApiException } from '@/data/api/types';

const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/data/api/access-requests', () => ({
  accessRequestsApi: {
    create: vi.fn(),
  },
}));

import { accessRequestsApi } from '@/data/api/access-requests';

function setup() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PID}/access`]}>
      <Routes>
        <Route
          path='/project/:projectId/access'
          element={<AccessRequestPage />}
        />
        <Route path='/studio' element={<div>StudioStub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccessRequestPage', () => {
  it('renders the form with role radios + message textarea + submit', () => {
    setup();
    // role radios are role='radio' inputs; query by their data-testid
    expect(screen.getByTestId('access-request-role-view')).toBeInTheDocument();
    expect(screen.getByTestId('access-request-role-edit')).toBeInTheDocument();
    expect(screen.getByTestId('access-request-message')).toBeInTheDocument();
    expect(screen.getByTestId('access-request-submit')).toBeInTheDocument();
  });

  it('defaults role to "view" + lets the user switch to "edit"', async () => {
    const user = userEvent.setup();
    setup();
    const view = screen.getByTestId('access-request-role-view') as HTMLInputElement;
    const edit = screen.getByTestId('access-request-role-edit') as HTMLInputElement;
    expect(view.checked).toBe(true);
    expect(edit.checked).toBe(false);
    await user.click(edit);
    expect(edit.checked).toBe(true);
    expect(view.checked).toBe(false);
  });

  it('submits the form with the selected role + trimmed message, then shows the submitted state', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.create).mockResolvedValueOnce({
      data: {
        id: 'ar-1',
        projectId: PID,
        requesterUserId: 'u-1',
        requestedRole: 'edit',
        message: 'please add me',
        status: 'pending',
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    });
    setup();
    await user.click(screen.getByTestId('access-request-role-edit'));
    await user.type(
      screen.getByTestId('access-request-message'),
      '   please add me   ',
    );
    await user.click(screen.getByTestId('access-request-submit'));

    expect(accessRequestsApi.create).toHaveBeenCalledWith(PID, {
      requested_role: 'edit',
      message: 'please add me', // trimmed
    });
    // submitted state — "Back to studio" link visible + form gone
    expect(screen.queryByTestId('access-request-submit')).not.toBeInTheDocument();
  });

  it('sends message=null when textarea is empty (not "")', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.create).mockResolvedValueOnce({
      data: {
        id: 'ar-2',
        projectId: PID,
        requesterUserId: 'u-1',
        requestedRole: 'view',
        message: null,
        status: 'pending',
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    });
    setup();
    await user.click(screen.getByTestId('access-request-submit'));

    expect(accessRequestsApi.create).toHaveBeenCalledWith(PID, {
      requested_role: 'view',
      message: null,
    });
  });

  it('shows ApiException.message inline when the request is rejected', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.create).mockRejectedValueOnce(
      new ApiException({ status: 409, code: 'CONFLICT', message: 'Already a member' }),
    );
    setup();
    await user.click(screen.getByTestId('access-request-submit'));

    // Error message rendered + submit button STILL there (form not gone)
    expect(await screen.findByText(/Already a member/)).toBeInTheDocument();
    expect(screen.getByTestId('access-request-submit')).toBeInTheDocument();
  });

  it('falls back to generic message when error is not an ApiException', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.create).mockRejectedValueOnce(
      new Error('network down'),
    );
    setup();
    await user.click(screen.getByTestId('access-request-submit'));

    // FieldError renders SOME error text (i18n key fallback);
    // the original Error message is not leaked — only the
    // generic fallback from t('access.request.submitFailed').
    expect(
      await screen.findByText(/access\.request\.submitFailed/),
    ).toBeInTheDocument();
  });
});
