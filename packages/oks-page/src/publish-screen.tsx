"use client";
// Tools > Publish: the places the owner sends the exported site to, and a button to publish to each. The exported site is the
// folder `oks export` makes; this screen sends it (only what changed, in an order that never leaves a broken site).
import type { PublishLast, PublishTargetConfig } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useEffect, useState } from "react";

export interface PublishState {
  targets: PublishTargetConfig[];
  last: Record<string, PublishLast>;
  running: { targetId: string; startedAt: number; steps: number } | null;
  exportReady: boolean;
  exportFolder: string;
  zipFolder: string;
}

const KIND: Record<string, string> = { folder: "A folder", zip: "A zip file" };

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function PublishScreen({ initial }: { initial: PublishState }) {
  const [state, setState] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<{
    id: string | null;
    kind: string;
    label: string;
    path: string;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/admin/publish");
    if (response.ok) setState((await response.json()) as PublishState);
  }

  // While a publish runs the screen asks how it is going.
  const running = state.running !== null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [running]);

  async function post(body: Record<string, unknown>) {
    setProblem(null);
    const response = await fetch("/api/admin/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setProblem(answer?.error?.message ?? "That did not work.");
      return false;
    }
    return true;
  }

  async function save() {
    if (!editing) return;
    if (
      await post({
        action: "save",
        ...(editing.id ? { id: editing.id } : {}),
        kind: editing.kind,
        label: editing.label,
        path: editing.path,
      })
    ) {
      setNote(`${editing.label} is saved.`);
      setEditing(null);
      await refresh();
    }
  }

  async function run(target: PublishTargetConfig) {
    setNote("");
    if (await post({ action: "run", id: target.id })) {
      setNote(`Publishing to ${target.label}…`);
      await refresh();
    }
  }

  async function remove(target: PublishTargetConfig) {
    setProblem(null);
    const response = await fetch(`/api/admin/publish?id=${encodeURIComponent(target.id)}`, {
      method: "DELETE",
    });
    setRemoving(null);
    if (!response.ok) setProblem("The place could not be removed.");
    else setNote(`${target.label} is removed.`);
    await refresh();
  }

  return (
    <section aria-labelledby="publish-heading">
      <h2 id="publish-heading">Publish</h2>
      <p>
        A static site is a folder of plain files. Make it with <code>oks export</code>, then send it
        to the places below. Only the files that changed are sent, and the order never leaves a
        broken site if a publish is cut off.
      </p>
      <p>
        The exported site is read from <code>{state.exportFolder}</code>.{" "}
        {state.exportReady
          ? "It is ready."
          : 'It is not there yet: run "oks export" to make it, then come back.'}
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status" style={{ minBlockSize: "1.5rem" }}>
        {state.running
          ? `Publishing to ${state.targets.find((t) => t.id === state.running!.targetId)?.label ?? "the place"}… ${state.running.steps} step${state.running.steps === 1 ? "" : "s"} done.`
          : note}
      </p>
      {state.targets.length === 0 ? (
        <p>There is no place to publish to yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Place</th>
              <th scope="col">Kind</th>
              <th scope="col">Where</th>
              <th scope="col">Last publish</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.targets.map((t) => {
              const last = state.last[t.id];
              return (
                <tr key={t.id}>
                  <th scope="row">{t.label}</th>
                  <td>{KIND[t.kind] ?? t.kind}</td>
                  <td>
                    <code>{t.kind === "zip" ? `${state.zipFolder}/${t.path}` : t.path}</code>
                  </td>
                  <td>{last ? `${when(last.at)}: ${last.message}` : "Never"}</td>
                  <td>
                    <Button
                      color="primary"
                      isDisabled={running || !state.exportReady}
                      onPress={() => void run(t)}
                    >
                      Publish now
                    </Button>{" "}
                    <Button onPress={() => setEditing({ ...t })}>Edit</Button>{" "}
                    {removing === t.id ? (
                      <>
                        Remove {t.label}?{" "}
                        <Button onPress={() => void remove(t)}>Yes, remove</Button>{" "}
                        <Button onPress={() => setRemoving(null)}>No</Button>
                      </>
                    ) : (
                      <Button onPress={() => setRemoving(t.id)}>Remove</Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p>
        <Button onPress={() => setEditing({ id: null, kind: "folder", label: "", path: "" })}>
          Add a place
        </Button>
      </p>
      {editing ? (
        <form
          aria-label={editing.id ? "Change this place" : "Add a place"}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p>
            <label>
              Name
              <br />
              <input
                value={editing.label}
                onChange={(event) => setEditing({ ...editing, label: event.target.value })}
              />
            </label>
          </p>
          <p>
            <label>
              Kind
              <br />
              <select
                value={editing.kind}
                onChange={(event) => setEditing({ ...editing, kind: event.target.value })}
              >
                <option value="folder">A folder on this computer</option>
                <option value="zip">A zip file</option>
              </select>
            </label>
          </p>
          <p>
            <label>
              {editing.kind === "zip" ? "File name" : "Folder (the whole path)"}
              <br />
              <input
                value={editing.path}
                placeholder={editing.kind === "zip" ? "site.zip" : "/var/www/site"}
                onChange={(event) => setEditing({ ...editing, path: event.target.value })}
              />
            </label>
            <br />
            <small>
              {editing.kind === "zip"
                ? `The zip file is written in ${state.zipFolder}.`
                : "Every file of the site is written here, and files that are no longer in the site are removed from it."}
            </small>
          </p>
          <p>
            <Button type="submit" color="primary">
              Save this place
            </Button>{" "}
            <Button onPress={() => setEditing(null)}>Cancel</Button>
          </p>
        </form>
      ) : null}
    </section>
  );
}
