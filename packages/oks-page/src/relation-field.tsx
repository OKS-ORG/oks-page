"use client";
// A link field on the edit screen: a box to choose one published entry of the type the field links to. A link to an
// entry that is gone (or no longer published) shows as "deleted item" until another one is chosen or it is cleared.
import { useEffect, useState } from "react";

export function RelationField({
  label,
  target,
  value,
  onChange,
}: {
  label: string;
  target: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [choices, setChoices] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    let current = true;
    void fetch(`/api/admin/entries?type=${encodeURIComponent(target)}`)
      .then((r) => r.json())
      .then((body: { choices?: { id: string; title: string }[] }) => {
        if (current) setChoices(body.choices ?? []);
      })
      .catch(() => {
        if (current) setChoices([]);
      });
    return () => {
      current = false;
    };
  }, [target]);
  const known = choices?.some((c) => c.id === value) ?? true;
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{choices === null ? "Loading…" : "None"}</option>
      {value && !known ? <option value={value}>(deleted item)</option> : null}
      {(choices ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.title}
        </option>
      ))}
    </select>
  );
}
