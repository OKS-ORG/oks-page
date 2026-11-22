"use client";
// The editor of a list setting of a plugin's block (spec 04, section 8): the plugin says what each item asks for (short
// texts, choices from a drop-down list, yes or no) and the admin draws the list with buttons to add, move and remove an
// item. It is the same for every plugin, so a plugin screen looks like the rest of the admin and runs no code here. Every
// control has a name that says which item it belongs to, so it works with a screen reader and from the keyboard.
import { Button } from "oks-ui";
import { cloneElement, type ReactElement } from "react";

export interface ListItemField {
  key: string;
  label: string;
  type: "text" | "boolean";
  options?: { value: string; label: string }[];
}

type Row = Record<string, string | boolean>;

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);

/** What a new item starts as: no text, nothing ticked, and the first choice of a drop-down list. */
function emptyRow(item: ListItemField[]): Row {
  const row: Row = {};
  for (const f of item) row[f.key] = f.type === "boolean" ? false : (f.options?.[0]?.value ?? "");
  return row;
}

export function PluginListEditor({
  label,
  itemName,
  item,
  most,
  value,
  onChange,
}: {
  /** What the list is called ("Form fields"). */
  label: string;
  /** What one item is called ("field"). */
  itemName: string;
  item: ListItemField[];
  most: number;
  value: unknown;
  onChange: (rows: Row[]) => void;
}) {
  const rows = Array.isArray(value) ? value.filter(isRow) : [];
  const change = (i: number, key: string, v: string | boolean) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const move = (i: number, by: number) => {
    const to = i + by;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[i], next[to]] = [next[to]!, next[i]!];
    onChange(next);
  };
  const field = (i: number, f: ListItemField, control: ReactElement<Record<string, unknown>>) => (
    <p key={f.key} style={{ margin: "0.25rem 0" }}>
      <span aria-hidden="true">{f.label}</span>
      <br />
      {cloneElement(control, { "aria-label": `${f.label} (${itemName} ${i + 1})` })}
    </p>
  );
  return (
    <fieldset style={{ margin: "0.5rem 0", padding: "0.5rem" }}>
      <legend>{label}</legend>
      {rows.length === 0 ? <p>No {itemName}s yet.</p> : null}
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {rows.map((row, i) => (
          <li
            key={i}
            style={{
              border: "1px solid currentColor",
              borderRadius: 6,
              margin: "0.5rem 0",
              padding: "0.5rem",
            }}
          >
            <strong>
              {itemName[0]!.toUpperCase()}
              {itemName.slice(1)} {i + 1}
            </strong>
            {item.map((f) =>
              f.type === "boolean"
                ? field(
                    i,
                    f,
                    <input
                      type="checkbox"
                      checked={row[f.key] === true}
                      onChange={(e) => change(i, f.key, e.target.checked)}
                    />,
                  )
                : f.options
                  ? field(
                      i,
                      f,
                      <select
                        value={String(row[f.key] ?? "")}
                        onChange={(e) => change(i, f.key, e.target.value)}
                      >
                        {f.options.some((o) => o.value === row[f.key]) ? null : (
                          <option value={String(row[f.key] ?? "")}>Choose…</option>
                        )}
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>,
                    )
                  : field(
                      i,
                      f,
                      <input
                        style={{ width: "100%" }}
                        value={String(row[f.key] ?? "")}
                        onChange={(e) => change(i, f.key, e.target.value)}
                      />,
                    ),
            )}
            <p style={{ margin: "0.25rem 0" }}>
              <Button
                aria-label={`Move ${itemName} ${i + 1} up`}
                isDisabled={i === 0}
                onPress={() => move(i, -1)}
              >
                Up
              </Button>{" "}
              <Button
                aria-label={`Move ${itemName} ${i + 1} down`}
                isDisabled={i === rows.length - 1}
                onPress={() => move(i, 1)}
              >
                Down
              </Button>{" "}
              <Button
                aria-label={`Remove ${itemName} ${i + 1}`}
                onPress={() => onChange(rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </p>
          </li>
        ))}
      </ol>
      <Button isDisabled={rows.length >= most} onPress={() => onChange([...rows, emptyRow(item)])}>
        Add a {itemName}
      </Button>
      {rows.length >= most ? <small> That is the most ({most}).</small> : null}
    </fieldset>
  );
}
