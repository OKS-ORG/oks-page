"use client";
// One choice drawn as a card; the real radio button inside it is what the keyboard and screen readers use. Used by the setup
// wizard and the Appearance screen.
import type { ReactNode } from "react";

export function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="oks-choice" data-checked={checked}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
      />
      {children}
    </label>
  );
}
