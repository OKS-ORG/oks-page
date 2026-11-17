"use client";
// "Accessibility check" under the editor (spec 03, section 8; EC-41): what a person using a screen reader or a keyboard
// would struggle with in this page, in plain words. It is advice only; it never stops saving or publishing.
import { Button } from "oks-ui";
import { checkAccessibility, type CheckedBlock } from "./accessibility";

/**
 * Takes the person to a block in the editor: scrolls it into view and puts the keyboard focus on it (on its text
 * when it has some, otherwise on the block itself), so a screen reader says where they are.
 */
export function goToBlock(blockId: string): boolean {
  const root = document.querySelector(".oks-entry-editor");
  const block = Array.from(root?.querySelectorAll<HTMLElement>("[data-block-id]") ?? []).find(
    (el) => el.dataset["blockId"] === blockId,
  );
  if (!block) return false;
  block.scrollIntoView({ block: "center" });
  const target =
    block.querySelector<HTMLElement>('[contenteditable="true"], a[href], button, input') ?? block;
  if (target === block && !block.hasAttribute("tabindex")) block.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return true;
}

export function EntryAccessibility({
  blocks,
  onMarkDecorative,
}: {
  blocks: unknown[];
  /** Marks a picture as only decoration (so it needs no description). */
  onMarkDecorative?: (blockId: string) => void;
}) {
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
                <strong>{issue.where}:</strong> {issue.message}{" "}
                <Button size="sm" onPress={() => goToBlock(issue.blockId)}>
                  Go to {issue.where}
                </Button>
                {issue.rule === "missing-alt" && onMarkDecorative ? (
                  <>
                    {" "}
                    <Button size="sm" onPress={() => onMarkDecorative(issue.blockId)}>
                      Mark {issue.where} as decoration
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
