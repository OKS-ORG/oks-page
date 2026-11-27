// A list screen's table (spec 07, section 6): 50 rows a page, sortable columns, selectable rows, scrolls inside its own box.
import { Pagination, Table, type TableColumn } from "oks-ui";
import { useMemo, useState } from "react";

export const PAGE_SIZE = 50;

type Key = string | number;
export type ListSort = { column: string; direction: "ascending" | "descending" };

export interface ListTableProps<Row extends Record<string, unknown>> {
  label: string;
  columns: TableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => Key;
  onSelectionChange?: (keys: Set<Key>) => void;
  /** Set `sort` to let the screen own the order (a "sort by" box beside the table); the column buttons then change it too. */
  sort?: ListSort | null;
  onSortChange?: (next: ListSort | null) => void;
}

const compare = (a: unknown, b: unknown): number => {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};

export function ListTable<Row extends Record<string, unknown>>({
  label,
  columns,
  rows,
  getRowKey,
  onSelectionChange,
  sort: givenSort,
  onSortChange,
}: ListTableProps<Row>) {
  const [page, setPage] = useState(1);
  const [ownSort, setOwnSort] = useState<ListSort | null>(null);
  const sort = givenSort !== undefined ? givenSort : ownSort;
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.column);
    const value = (row: Row) => (column?.sortValue ? column.sortValue(row) : row[sort.column]);
    const sign = sort.direction === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [rows, columns, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  // A search can leave fewer pages than the one being looked at.
  const current = Math.min(page, pages);
  const shown = sorted.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const first = shown.length === 0 ? 0 : (current - 1) * PAGE_SIZE + 1;
  const last = shown.length === 0 ? 0 : first + shown.length - 1;
  return (
    <div className="oks-list">
      <div className="oks-list-scroll">
        <Table
          aria-label={label}
          columns={columns}
          rows={shown}
          getRowKey={getRowKey}
          sortDescriptor={sort}
          onSortChange={(next) => {
            setOwnSort(next);
            onSortChange?.(next);
            setPage(1);
          }}
          selectionMode="multiple"
          {...(onSelectionChange ? { onSelectionChange } : {})}
        />
      </div>
      <div className="oks-list-foot">
        <p className="oks-list-count">{`Showing ${first} to ${last} of ${sorted.length}`}</p>
        {pages > 1 ? (
          <Pagination
            aria-label={`${label} pages`}
            total={pages}
            page={current}
            onChange={setPage}
          />
        ) : null}
      </div>
    </div>
  );
}
