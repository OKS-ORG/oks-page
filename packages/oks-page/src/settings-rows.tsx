"use client";
// The rows of a settings screen, drawn as the boards show: a card with a title, one row for each setting (its name and help on
// the left, the control on the right), and a bar at the foot that says whether anything is unsaved.
import type { ReactNode } from "react";

export function SettingsCard({
  title,
  titleId,
  line,
  children,
}: {
  title: string;
  titleId?: string;
  line?: string;
  children: ReactNode;
}) {
  return (
    <div className="oks-set-card">
      <div className="oks-set-head">
        <h2 {...(titleId ? { id: titleId } : {})}>{title}</h2>
        {line ? <p>{line}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function SettingRow({
  label,
  htmlFor,
  help,
  helpId,
  children,
}: {
  label: string;
  /** The control the name belongs to; leave out for a group, which names itself. */
  htmlFor?: string;
  help?: ReactNode;
  helpId?: string;
  children: ReactNode;
}) {
  return (
    <div className="oks-set-row">
      <div className="oks-set-label">
        {htmlFor ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span aria-hidden="true">{label}</span>
        )}
        {help ? <p {...(helpId ? { id: helpId } : {})}>{help}</p> : null}
      </div>
      <div className="oks-set-control">{children}</div>
    </div>
  );
}

export function SaveBar({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className="oks-save-bar">
      <p role="status">{note}</p>
      {children}
    </div>
  );
}
