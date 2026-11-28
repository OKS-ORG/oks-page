"use client";
// The code from an authenticator app, in six boxes: when signing in and in the setup wizard.
import { useEffect, useRef } from "react";

/**
 * One real field, so that pasting and the phone's own code suggestion work, with six boxes drawn from what it holds.
 */
export function CodeBoxes({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div className="oks-code">
      <input
        ref={field}
        name="code"
        aria-label={label}
        autoComplete="one-time-code"
        inputMode="numeric"
        required
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      <div aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} data-next={i === Math.min(value.length, 5) ? "" : undefined}>
            {value[i] ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}
