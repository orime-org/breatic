// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type * as React from 'react';

import { projectsApi, studioProjectsListKey } from '@web/data/api/projects';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ProjectTimeKind } from '@web/pages/studio/container/container-types';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { toast } from '@web/lib/toast';

vi.mock('@web/data/api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/projects')>()),
  projectsApi: {
    rename: vi.fn(() => Promise.resolve({ name: 'Renamed' })),
    duplicate: vi.fn(() => Promise.resolve({ name: 'Copy of Cyberpunk Alley' })),
    archive: vi.fn(() => Promise.resolve({ ok: true })),
    restore: vi.fn(() => Promise.resolve({ ok: true })),
    leave: vi.fn(() => Promise.resolve({ ok: true })),
  },
}));

vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@web/data/api/project-join-requests', () => ({
  projectJoinRequestsApi: {
    mine: () =>
      Promise.resolve({
        project: { id: 'id-1', name: 'Cyberpunk Alley', studioSlug: 'acme', archivedAt: null },
        pendingRequest: null,
      }),
    request: vi.fn(),
    cancelMine: vi.fn(),
  },
}));

const project: ContainerProject = {
  id: 'id-1',
  slug: 'cyberpunk-alley',
  name: 'Cyberpunk Alley',
  thumbnailUrl: null,
  myRole: 'owner',
  // Created 30 min ago → en renders a relative "30 minutes ago" label.
  createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  archivedAt: null,
  lastOpenedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  lastEditedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
  canManageMeta: true,
  canDuplicate: true,
  canArchive: false,
  canRestore: false,
  canLeave: false,
};

// The flags the server sends for each caller on a live project
// (projectGovernance: the studio admin and the owner manage, only the admin archives).
const AS_STUDIO_ADMIN = { canManageMeta: true, canDuplicate: true, canArchive: true, canRestore: false, canLeave: false };
const AS_NOBODY = { canManageMeta: false, canDuplicate: false, canArchive: false, canRestore: false, canLeave: false };
const AS_EDITOR = { ...AS_NOBODY, canLeave: true };

function setup(p: ContainerProject = project, timeKind: ProjectTimeKind = 'created') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectCard project={p} timeKind={timeKind} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectCard', () => {
  it('renders the project name and links to /project/{slug}-{uuid}', () => {
    setup();
    expect(screen.getByText('Cyberpunk Alley')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/project/cyberpunk-alley-id-1',
    );
  });

  it('prefixes the time with the "created" label (the studio catalog shows creation time)', () => {
    // The container is a catalog: it shows the project's CREATION time (stable,
    // honest), not "modified" — canvas activity lives in Yjs and never bumps
    // the project row, so "modified" would mislead. The Recent landing handles
    // "what I recently opened" separately.
    setup();
    expect(screen.getByText(/^Created\b/i)).toBeInTheDocument();
  });

  it('shows the time the list is sorted by', () => {
    setup(project, 'opened');
    expect(screen.getByText('Opened 5 minutes ago')).toBeInTheDocument();
  });

  it('says only that a project was never opened, under the last-opened sort', () => {
    setup({ ...project, lastOpenedAt: null }, 'opened');
    expect(screen.getByText('Never opened')).toBeInTheDocument();
    expect(screen.queryByText(/Created/)).not.toBeInTheDocument();
  });

  it('keeps its own layers inside the card, so its menu never rises above the pinned toolbar', () => {
    setup();
    expect(screen.getByTestId(`project-card-${project.id}`).className).toMatch(/(^|\s)isolate(\s|$)/);
  });

  it('shows the edit time under the last-edited sort', () => {
    setup(project, 'edited');
    expect(screen.getByText('Edited 10 minutes ago')).toBeInTheDocument();
  });

  it('shows the archive time on an archived card under the archive sort', () => {
    setup({ ...project, archivedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString() }, 'archived');
    expect(screen.getByText('Archived 2 hours ago')).toBeInTheDocument();
  });

  it('uses the same card body as the Recent landing: 13px name, one meta line with the role as text', () => {
    setup();
    expect(screen.getByText('Cyberpunk Alley').className).toMatch(
      /\btext-sm\b.*\bfont-medium\b/,
    );
    const meta = screen.getByTestId('item-card-meta');
    expect(meta).toContainElement(screen.getByText(/^Created\b/));
    const role = screen.getByText('Owner');
    expect(meta).toContainElement(role);
    expect(role.tagName).toBe('SPAN');
    expect(role.className).not.toMatch(/\bbg-/);
  });

  it('shows the built-in default cover when the project has no cover', () => {
    setup();
    const cover = screen.getByRole('link').firstElementChild;
    expect(cover?.querySelector('[data-testid="default-project-cover"]')).not.toBeNull();
    expect(cover?.querySelector('img')).toBeNull();
  });

  it('shows the uploaded cover instead of the default one', () => {
    setup({ ...project, thumbnailUrl: 'https://cdn.test/cover.jpg' });
    const cover = screen.getByRole('link').firstElementChild;
    expect(cover?.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/cover.jpg');
    expect(cover?.querySelector('[data-testid="default-project-cover"]')).toBeNull();
  });

  it('lists rename, cover and duplicate for the project owner, and no archive', async () => {
    setup();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate']);
  });

  it('lists rename, cover, duplicate and archive for a studio admin who is not on the project', async () => {
    setup({ ...project, myRole: null, ...AS_STUDIO_ADMIN });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate', 'Archive']);
  });

  it('shows no ⋯ menu when the viewer may do none of it', () => {
    setup({ ...project, myRole: 'viewer', ...AS_NOBODY });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('offers an editor only Leave project', async () => {
    setup({ ...project, myRole: 'editor', ...AS_EDITOR });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Leave project']);
    expect(screen.getByRole('menuitem', { name: 'Leave project' })).toHaveClass('text-status-error-foreground');
  });

  it('puts Leave project last, after a separator, for a studio admin who is also an editor', async () => {
    setup({ ...project, myRole: 'editor', ...AS_STUDIO_ADMIN, canLeave: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate', 'Archive', 'Leave project']);
    const leave = screen.getByRole('menuitem', { name: 'Leave project' });
    expect(leave.previousElementSibling?.getAttribute('role')).toBe('separator');
  });

  it('leaves only after the confirmation, and cancelling changes nothing', async () => {
    const user = userEvent.setup();
    setup({ ...project, myRole: 'viewer', ...AS_EDITOR });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave project' }));
    const dialog = await screen.findByTestId('leave-project-dialog');
    expect(dialog).toHaveTextContent('Leave “Cyberpunk Alley”?');
    expect(dialog).toHaveTextContent('You won\'t be able to open this project after leaving.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(projectsApi.leave).not.toHaveBeenCalled();
    expect(screen.queryByTestId('leave-project-dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave project' }));
    const confirm = await screen.findByRole('button', { name: 'Leave' });
    expect(confirm).toHaveClass('text-status-error-foreground');
    await user.click(confirm);
    expect(projectsApi.leave).toHaveBeenCalledWith('id-1');
  });

  it('renames through the dialog', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    await user.clear(field);
    await user.type(field, '  Renamed  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(projectsApi.rename).toHaveBeenCalledWith('id-1', 'Renamed');
    // The dialog waits for the server and closes once the rename lands.
    await waitFor(() => expect(screen.queryByTestId('rename-project-dialog')).toBeNull());
  });

  it('duplicates straight from the menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(projectsApi.duplicate).toHaveBeenCalledWith('id-1');
  });

  it('archives only after the confirmation', async () => {
    const user = userEvent.setup();
    setup({ ...project, ...AS_STUDIO_ADMIN });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByTestId('archive-project-dialog');
    expect(dialog).toHaveTextContent('Archive “Cyberpunk Alley”?');
    expect(projectsApi.archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(projectsApi.archive).toHaveBeenCalledWith('id-1');
  });

  describe('an archived card', () => {
    const archived: ContainerProject = {
      ...project,
      archivedAt: '2026-10-01T00:00:00.000Z',
      canManageMeta: false,
      canDuplicate: false,
      canRestore: true,
    };

    it('carries the archived badge and offers only restore', async () => {
      const user = userEvent.setup();
      setup(archived);
      expect(screen.getByText('Archived')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'More actions' }));
      const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
      expect(items).toEqual(['Restore']);
      await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
      expect(projectsApi.restore).toHaveBeenCalledWith('id-1');
    });

    it('still opens for a member', () => {
      setup(archived);
      expect(screen.getByRole('link')).toHaveAttribute('href', '/project/cyberpunk-alley-id-1');
    });

    it('is not clickable for an admin who is not on the project', () => {
      setup({ ...archived, myRole: null });
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button', { name: /Cyberpunk Alley/ })).toBeNull();
    });
  });

  it('opens the join dialog in place for a project the viewer is not on', async () => {
    setup({ ...project, myRole: null, ...AS_NOBODY });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Owner')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: /Cyberpunk Alley/ }));

    expect(await screen.findByTestId('join-project-dialog')).toBeInTheDocument();
    expect(screen.getByText('You\'re not a member of this project')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});

describe('ProjectCard — picking a cover (inner#1367 A4)', () => {
  const RIFF_WEBP = [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

  // jsdom has no object URLs; the crop dialog asks for one to show the file.
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock/0'), revokeObjectURL: vi.fn() });
  });

  /**
   * Pick a file in the cover input.
   * @param bytes - The file's first bytes.
   * @param name - Its name.
   * @param type - The type it claims.
   */
  function pick(bytes: number[], name: string, type: string): void {
    const file = new File([new Uint8Array([...bytes, ...new Array<number>(64).fill(0)])], name, { type });
    fireEvent.change(screen.getByTestId('project-cover-input'), { target: { files: [file] } });
  }

  it('turns away a WebP named and typed as a JPEG, before the crop', async () => {
    setup();

    pick(RIFF_WEBP, 'cover.jpg', 'image/jpeg');

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Not a supported format. Use PNG or JPEG.'));
    expect(screen.queryByTestId('image-crop-dialog')).toBeNull();
  });

  it('opens the crop for a PNG', async () => {
    setup();

    pick(PNG, 'cover.png', 'image/png');

    await waitFor(() => expect(screen.getByTestId('image-crop-dialog')).toBeInTheDocument());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('ProjectCard — confirmations that wait for the server (inner#1374)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A request whose answer the case decides.
   * @param value - What it resolves to when it succeeds.
   * @param succeeds - Whether it resolves or rejects.
   * @returns The pending promise and the function that settles it.
   */
  function held<T>(value: T, succeeds: boolean): { promise: Promise<T>; settle: () => void } {
    let settle: () => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      settle = succeeds ? () => resolve(value) : () => reject(new Error('nope'));
    });
    return { promise, settle };
  }

  it.each([
    ['closes once it lands', true],
    ['stays open with Save pressable again when it fails', false],
  ])('keeps the rename dialog open with a busy Save while the rename is out, and %s', async (_label, succeeds) => {
    const request = held({ name: 'Renamed' } as Awaited<ReturnType<typeof projectsApi.rename>>, succeeds);
    vi.mocked(projectsApi.rename).mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Renamed');
    const save = screen.getByRole('button', { name: 'Save' });
    await user.click(save);

    await waitFor(() => expect(save).toHaveAttribute('aria-busy', 'true'));
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('rename-project-dialog')).toBeInTheDocument();

    request.settle();
    if (succeeds) {
      await waitFor(() => expect(screen.queryByTestId('rename-project-dialog')).toBeNull());
    } else {
      await waitFor(() => expect(save).not.toHaveAttribute('aria-busy'));
      expect(screen.getByTestId('rename-project-dialog')).toBeInTheDocument();
    }
  });

  it.each([
    ['closes once it lands', true],
    ['stays open with Archive pressable again when it fails', false],
  ])('keeps the archive confirmation open with a busy Archive while the archive is out, and %s', async (_label, succeeds) => {
    const request = held({ ok: true } as Awaited<ReturnType<typeof projectsApi.archive>>, succeeds);
    vi.mocked(projectsApi.archive).mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    setup({ ...project, ...AS_STUDIO_ADMIN });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await screen.findByTestId('archive-project-dialog');
    const confirm = screen.getByRole('button', { name: 'Archive' });
    await user.click(confirm);

    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('archive-project-dialog')).toBeInTheDocument();

    request.settle();
    if (succeeds) {
      await waitFor(() => expect(screen.queryByTestId('archive-project-dialog')).toBeNull());
    } else {
      await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
      expect(screen.getByTestId('archive-project-dialog')).toBeInTheDocument();
    }
  });

  it.each([
    ['closes once it lands', true],
    ['stays open with Leave pressable again when it fails', false],
  ])('keeps the leave confirmation open with a busy Leave while the leave is out, and %s', async (_label, succeeds) => {
    const request = held({ ok: true } as Awaited<ReturnType<typeof projectsApi.leave>>, succeeds);
    vi.mocked(projectsApi.leave).mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    setup({ ...project, myRole: 'editor', ...AS_EDITOR });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave project' }));
    const confirm = await screen.findByRole('button', { name: 'Leave' });
    await user.click(confirm);

    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('leave-project-dialog')).toBeInTheDocument();

    request.settle();
    if (succeeds) {
      await waitFor(() => expect(screen.queryByTestId('leave-project-dialog')).toBeNull());
    } else {
      await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
      expect(screen.getByTestId('leave-project-dialog')).toBeInTheDocument();
    }
  });

  /** One held studio list, as a case sees it. */
  interface HeldList {
    /** Answer the refetch that is out with these projects (none by default). */
    land: (items?: ContainerProject[]) => void;
    /** Whether a refetch is out. */
    started: () => boolean;
  }

  /**
   * A list read that answers its first read with `first` and holds every later
   * one until the case lands it.
   * @param first - The first read's answer.
   * @returns The read and its control.
   */
  function heldList(first: ContainerProject[]): { read: () => Promise<ContainerProject[]>; control: HeldList } {
    let land: ((items: ContainerProject[]) => void) | null = null;
    let reads = 0;
    const read = (): Promise<ContainerProject[]> => {
      reads += 1;
      return reads === 1
        ? Promise.resolve(first)
        : new Promise((resolve) => {
          land = resolve;
        });
    };
    return { read, control: { land: (items = []) => land?.(items), started: () => land !== null } };
  }

  /**
   * Render the card inside the studio's live list, next to the archived list,
   * both read the way the studio page reads them (an admin has both mounted),
   * with every refetch held until the case lands it.
   * @param p - The card's project, listed in the live list.
   * @returns The two lists' controls.
   */
  function setupInHeldLists(p: ContainerProject): { live: HeldList; archived: HeldList } {
    const live = heldList([p]);
    const archived = heldList([]);
    /**
     * Stands in for one of the studio's project lists.
     * @param props - Which list, and how it reads.
     * @param props.archived - Whether this is the archived list.
     * @param props.read - Its read.
     * @returns One card per listed project.
     */
    function List(props: { archived: boolean; read: () => Promise<ContainerProject[]> }): React.JSX.Element {
      const list = useQuery({
        queryKey: studioProjectsListKey('acme', {
          archived: props.archived,
          sort: props.archived ? 'archived' : 'opened',
          locale: 'en',
        }),
        queryFn: props.read,
      });
      return <>{(list.data ?? []).map((item) => <ProjectCard key={item.id} project={item} timeKind='created' />)}</>;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <List archived={false} read={live.read} />
          <List archived read={archived.read} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { live: live.control, archived: archived.control };
  }

  /**
   * Open the rename dialog and save a new name.
   * @returns The Save button.
   */
  async function renameFromTheCard(): Promise<HTMLElement> {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Renamed');
    const save = screen.getByRole('button', { name: 'Save' });
    await user.click(save);
    return save;
  }

  it('keeps the rename dialog busy until the live list refetch shows the new name', async () => {
    const lists = setupInHeldLists(project);
    const save = await renameFromTheCard();

    await waitFor(() => expect(lists.live.started() && lists.archived.started()).toBe(true));
    await act(async () => lists.archived.land());
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('rename-project-dialog')).toBeInTheDocument();
    lists.live.land([{ ...project, name: 'Renamed' }]);
    await waitFor(() => expect(screen.queryByTestId('rename-project-dialog')).toBeNull());
  });

  it('closes the rename dialog once the live list shows the name, without waiting for the archived list', async () => {
    const lists = setupInHeldLists(project);
    await renameFromTheCard();

    await waitFor(() => expect(lists.live.started() && lists.archived.started()).toBe(true));
    lists.live.land([{ ...project, name: 'Renamed' }]);
    await waitFor(() => expect(screen.queryByTestId('rename-project-dialog')).toBeNull());
    expect(screen.getByText('Renamed')).toBeInTheDocument();
  });

  it('holds the archived toast until the archived list refetch lands, after the live list drops the card', async () => {
    const user = userEvent.setup();
    const lists = setupInHeldLists({ ...project, ...AS_STUDIO_ADMIN });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await screen.findByTestId('archive-project-dialog');
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(lists.live.started() && lists.archived.started()).toBe(true));
    lists.live.land();
    await waitFor(() => expect(screen.queryByTestId(`project-card-${project.id}`)).toBeNull());
    expect(toast.success).not.toHaveBeenCalledWith('Archived');

    await act(async () =>
      lists.archived.land([{ ...project, ...AS_STUDIO_ADMIN, archivedAt: '2026-10-01T00:00:00.000Z' }]),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archived'));
  });

  it('keeps the archive confirmation busy until the list refetch takes the card away', async () => {
    const user = userEvent.setup();
    const lists = setupInHeldLists({ ...project, ...AS_STUDIO_ADMIN });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await screen.findByTestId('archive-project-dialog');
    const confirm = screen.getByRole('button', { name: 'Archive' });
    await user.click(confirm);

    await waitFor(() => expect(lists.live.started()).toBe(true));
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('archive-project-dialog')).toBeInTheDocument();
    lists.live.land();
    await waitFor(() => expect(screen.queryByTestId('archive-project-dialog')).toBeNull());
    expect(screen.queryByTestId(`project-card-${project.id}`)).toBeNull();
  });

  it('keeps the leave confirmation busy until the list refetch takes the card away', async () => {
    const user = userEvent.setup();
    const lists = setupInHeldLists({ ...project, myRole: 'editor', ...AS_EDITOR });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave project' }));
    const confirm = await screen.findByRole('button', { name: 'Leave' });
    await user.click(confirm);

    await waitFor(() => expect(lists.live.started()).toBe(true));
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('leave-project-dialog')).toBeInTheDocument();
    lists.live.land();
    await waitFor(() => expect(screen.queryByTestId('leave-project-dialog')).toBeNull());
    expect(screen.queryByTestId(`project-card-${project.id}`)).toBeNull();
  });
});
