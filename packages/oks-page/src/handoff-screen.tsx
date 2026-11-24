"use client";
// Tools > Handoff (spec 11, section 9): the checklist for giving a site to a client. Each item has a plain explanation, a link
// to the place where it is done, a note when the site can already tell, and a tick that is saved at once.
import type { HandoffView } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useState } from "react";

export function HandoffScreen({ initial }: { initial: HandoffView }) {
  const [done, setDone] = useState<string[]>(initial.items.filter((i) => i.done).map((i) => i.id));
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function toggle(id: string, on: boolean) {
    const next = on ? [...done, id] : done.filter((x) => x !== id);
    const before = done;
    setDone(next);
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/handoff", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: next }),
    });
    if (!response.ok) {
      setDone(before);
      setNote("");
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setProblem(body?.error?.message ?? "The checklist could not be saved.");
      return;
    }
    setNote(`Saved. ${next.length} of ${initial.total} done.`);
  }

  return (
    <>
      <p>
        Go through this list before you give the site to its owner. Giving a site away never needs a
        licence. Tick an item when it is really done; the site only tells you what it can see.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p>
        <strong>
          {done.length} of {initial.total} done
        </strong>
        {done.length === initial.total ? " — ready to hand over." : "."}
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          display: "grid",
          gap: "1rem",
          maxInlineSize: "46rem",
        }}
      >
        {initial.items.map((item) => (
          <li key={item.id}>
            <label style={{ display: "flex", gap: ".6rem", alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={done.includes(item.id)}
                onChange={(event) => void toggle(item.id, event.target.checked)}
                style={{ inlineSize: "1.25rem", blockSize: "1.25rem", marginBlockStart: ".2rem" }}
              />
              <span>
                <strong>{item.title}</strong>
                <br />
                {item.why}
                {item.hint ? (
                  <>
                    <br />
                    <em>{item.hint}</em>
                  </>
                ) : null}
                {item.href ? (
                  <>
                    <br />
                    <a href={item.href}>Open the place to do it</a>
                  </>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p role="status">{note}</p>
    </>
  );
}
