"use client";
// A screen a plugin described as data (spec 04, section 9): a table of the plugin's own stored items with filters, a button
// or two on each row, and a CSV download. The words and the order of the columns come from the plugin; everything else
// (how it looks, what a button may do) is fixed by the admin, so a plugin screen runs no code here.
import { Alert, Button } from "oks-ui";
import { useState } from "react";
import type { PluginPageView, PluginRow } from "./plugin-pages";

export function PluginPageScreen({
  plugin,
  page,
  initial,
}: {
  plugin: string;
  page: string;
  initial: PluginPageView;
}) {
  const [view, setView] = useState(initial);
  const [rows, setRows] = useState<PluginRow[]>(initial.rows);
  const [next, setNext] = useState<string | null>(initial.next);
  const [filter, setFilter] = useState(initial.filter);
  const [asking, setAsking] = useState<{ key: string; action: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const query = (f: number, after?: string) =>
    `/api/admin/plugin-pages?plugin=${encodeURIComponent(plugin)}&page=${encodeURIComponent(page)}${
      f >= 0 ? `&filter=${f}` : ""
    }${after ? `&after=${encodeURIComponent(after)}` : ""}`;

  async function load(f: number, after?: string) {
    setProblem(null);
    setBusy(true);
    const response = await fetch(query(f, after));
    const body = (await response.json().catch(() => null)) as {
      view?: PluginPageView;
      error?: { message?: string };
    } | null;
    setBusy(false);
    if (!response.ok || !body?.view) {
      setProblem(body?.error?.message ?? "The list could not be loaded.");
      return;
    }
    setView(body.view);
    setFilter(body.view.filter);
    setRows(after ? (current) => [...current, ...body.view!.rows] : body.view.rows);
    setNext(body.view.next);
  }

  async function act(key: string, action: string, label: string) {
    setAsking(null);
    setProblem(null);
    const response = await fetch("/api/admin/plugin-pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plugin, page, action, key }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setProblem(body?.error?.message ?? "That did not work.");
      return;
    }
    setNote(`Done: ${label}.`);
    await load(filter);
  }

  return (
    <section aria-labelledby="plugin-page-heading">
      <h2 id="plugin-page-heading">{view.title}</h2>
      <p>
        <small>From the plugin {view.pluginName}.</small>
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status" style={{ minBlockSize: "1.5rem" }}>
        {note}
      </p>
      {view.filters.length > 0 ? (
        <div role="group" aria-label="Show">
          {view.filters.map((label, i) => (
            <Button key={label} onPress={() => void load(i)} aria-pressed={filter === i}>
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      {view.canExport ? (
        <p>
          <a href={`${query(filter)}&export=1`} download>
            Download as a CSV file
          </a>
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p>{view.empty}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <caption className="oks-sr-only">{view.title}</caption>
            <thead>
              <tr>
                {view.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
                {view.actions.length > 0 ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((cell, i) => (
                    <td key={i} style={{ verticalAlign: "top" }}>
                      {cell.links ? (
                        cell.links.map((l, n) => (
                          <span key={l.href}>
                            {n > 0 ? ", " : ""}
                            <a href={l.href} download>
                              {l.text}
                            </a>
                          </span>
                        ))
                      ) : cell.full !== undefined ? (
                        <details>
                          <summary>{cell.text}</summary>
                          <div style={{ whiteSpace: "pre-wrap" }}>{cell.full}</div>
                        </details>
                      ) : (
                        cell.text
                      )}
                    </td>
                  ))}
                  {view.actions.length > 0 ? (
                    <td style={{ verticalAlign: "top" }}>
                      {asking?.key === row.key ? (
                        <>
                          <span>Are you sure? </span>
                          <Button
                            color="danger"
                            onPress={() =>
                              void act(
                                row.key,
                                asking.action,
                                view.actions.find((a) => a.id === asking.action)?.label ?? "",
                              )
                            }
                          >
                            Yes, {view.actions.find((a) => a.id === asking.action)?.label}
                          </Button>{" "}
                          <Button onPress={() => setAsking(null)}>Cancel</Button>
                        </>
                      ) : (
                        view.actions.map((a) => (
                          <span key={a.id}>
                            <Button
                              {...(a.kind === "delete" ? { color: "danger" as const } : {})}
                              onPress={() =>
                                a.confirm
                                  ? setAsking({ key: row.key, action: a.id })
                                  : void act(row.key, a.id, a.label)
                              }
                            >
                              {a.label}
                            </Button>{" "}
                          </span>
                        ))
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <p>
          <Button isDisabled={busy} onPress={() => void load(filter, next)}>
            Show more
          </Button>
        </p>
      ) : null}
    </section>
  );
}
