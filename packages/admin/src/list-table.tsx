// A list screen's table (spec 07, section 6): 50 rows a page, sortable columns, selectable rows, scrolls inside its own box.
import { Pagination, Table, type TableColumn } from "oks-ui";
import { useMemo, useState } from "react";

export const PAGE_SIZE = 50;

type Key = string | number;
type Sort = { column: string; direction: "ascending" | "descending" };

export interface ListTableProps<Row extends Record<string, unknown>> {
  label: string;
  columns: TableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => Key;
  onSelectionChange?: (keys: Set<Key>) => void;
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
}: ListTableProps<Row>) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.column);
    const value = (row: Row) => (column?.sortValue ? column.sortValue(row) : row[sort.column]);
    const sign = sort.direction === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [rows, columns, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const shown = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
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
            setSort(next);
            setPage(1);
          }}
          selectionMode="multiple"
          {...(onSelectionChange ? { onSelectionChange } : {})}
        />
      </div>
      {pages > 1 ? (
        <Pagination aria-label={`${label} pages`} total={pages} page={page} onChange={setPage} />
      ) : null}
    </div>
  );
}
