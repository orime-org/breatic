import type { Table as TanStackTable } from '@tanstack/react-table';
import type { TablePaginationConfig } from './index';

interface PaginationProps<TData> {
  table: TanStackTable<TData>;
  pagination: TablePaginationConfig;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export const Pagination = <TData,>({
  table,
  pagination,
  onPageChange,
  onPageSizeChange,
}: PaginationProps<TData>) => {
  return (
    <div className='flex items-center justify-between mt-4 px-4'>
      <div className='text-sm text-text-disabled-secondary'>
        Total {pagination.total ?? table.getRowCount()}
      </div>
      <div className='flex items-center gap-2'>
        <button
          onClick={() => onPageChange(table.getState().pagination.pageIndex - 1)}
          disabled={!table.getCanPreviousPage()}
          className='px-3 py-1 text-sm border border-[var(--color-border-default-base)] rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-default-secondary'
        >
          Previous
        </button>
        <span className='text-sm text-text-default-base'>
          {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
        </span>
        <button
          onClick={() => onPageChange(table.getState().pagination.pageIndex + 1)}
          disabled={!table.getCanNextPage()}
          className='px-3 py-1 text-sm border border-[var(--color-border-default-base)] rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-default-secondary'
        >
          Next
        </button>
        {pagination.showSizeChanger && (
          <select
            value={table.getState().pagination.pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className='px-2 py-1 text-sm border border-[var(--color-border-default-base)] rounded bg-background-default-base'
          >
            {(pagination.pageSizeOptions || ['10', '20', '50', '100']).map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
};

