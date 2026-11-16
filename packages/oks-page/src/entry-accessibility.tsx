"use client";
// "Accessibility check" under the editor (spec 03, section 8; EC-41): what a person using a screen reader or a keyboard
// would struggle with in this page, in plain words. It is advice only; it never stops saving or publishing.
import { checkAccessibility, type CheckedBlock } from "./accessibility";

export function EntryAccessibility({ blocks }: { blocks: unknown[] }) {
  const issues = checkAccessibility(blocks as CheckedBlock[]);
  return (
    <section aria-label="Accessibility check" className="oks-a11y-check">
      <h2 style={{ fontSize: "1rem", margin: "1rem 0 0.25rem" }}>Accessibility check</h2>
      {issues.length === 0 ? (
        <p role="status">Nothing to fix. This page reads well for everyone.</p>
      ) : (
        <>
          <p role="status">
            {issues.length} {issues.length === 1 ? "thing" : "things"} to look at. This is advice:
            you can still save and publish.
          </p>
          <ul>
            {issues.map((issue, i) => (
              <li key={`${issue.blockId}-${issue.rule}-${i}`}>
                <strong>{issue.where}:</strong> {issue.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
