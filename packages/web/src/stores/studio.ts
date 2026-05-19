import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Studio page UI store — project list filter / sort / search.
 *
 * Project list data itself lives in React Query cache (from
 * `data/api/projects.ts`); this store holds only the UI filters used to
 * derive the visible subset.
 */
export type ProjectSortKey = 'updated' | 'created' | 'name';
export type ProjectSortOrder = 'asc' | 'desc';

interface StudioState {
  search: string;
  sortKey: ProjectSortKey;
  sortOrder: ProjectSortOrder;
  filterOwnerOnly: boolean;
  setSearch: (q: string) => void;
  setSort: (key: ProjectSortKey, order: ProjectSortOrder) => void;
  setFilterOwnerOnly: (v: boolean) => void;
}

export const useStudioStore = create<StudioState>()(
  immer((set) => ({
    search: '',
    sortKey: 'updated',
    sortOrder: 'desc',
    filterOwnerOnly: false,
    setSearch: (q) =>
      set((s) => {
        s.search = q;
      }),
    setSort: (key, order) =>
      set((s) => {
        s.sortKey = key;
        s.sortOrder = order;
      }),
    setFilterOwnerOnly: (v) =>
      set((s) => {
        s.filterOwnerOnly = v;
      }),
  })),
);
