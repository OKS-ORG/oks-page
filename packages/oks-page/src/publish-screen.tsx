"use client";
// Tools > Publish: the places the owner sends the exported site to, and a button to publish to each. The exported site is the
// folder `oks export` makes; this screen sends it (only what changed, in an order that never leaves a broken site).
import type { PublicPublishTarget, PublishLast } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useEffect, useState } from "react";

export interface PublishState {
  targets: PublicPublishTarget[];
  last: Record<string, PublishLast>;
  running: { targetId: string; startedAt: number; steps: number } | null;
  exportReady: boolean;
  exportFolder: string;
  zipFolder: string;
}

interface Draft {
  id: string | null;
  kind: string;
  label: string;
  path: string;
  host: string;
  port: string;
  username: string;
  auth: "password" | "key";
  hostKey: string;
  /** What was typed; a secret that was not touched is left out of the request, so the saved one stays. */
  password: string;
  privateKey: string;
  passphrase: string;
  /** The saved secrets of the place being changed. */
  has: { password: boolean; privateKey: boolean; passphrase: boolean };
  /** The fingerprint the server showed, waiting for the owner to confirm it. */
  seen: string;
  confirmed: boolean;
}

const KIND: Record<string, string> = {
  folder: "A folder",
  zip: "A zip file",
  sftp: "An SFTP server",
};

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";

const blank = (): Draft => ({
  id: null,
  kind: "folder",
  label: "",
  path: "",
  host: "",
  port: "22",
  username: "",
  auth: "password",
  hostKey: "",
  password: "",
  privateKey: "",
  passphrase: "",
  has: { password: false, privateKey: false, passphrase: false },
  seen: "",
  confirmed: false,
});

const draftOf = (t: PublicPublishTarget): Draft => ({
  ...blank(),
  id: t.id,
  kind: t.kind,
  label: t.label,
  path: t.path,
  has: t.has,
  ...(t.sftp
    ? {
        host: t.sftp.host,
        port: String(t.sftp.port),
        username: t.sftp.username,
        auth: t.sftp.auth,
        hostKey: t.sftp.hostKey,
      }
    : {}),
});

const where = (t: PublicPublishTarget, zipFolder: string): string =>
  t.kind === "zip"
    ? `${zipFolder}/${t.path}`
    : t.kind === "sftp" && t.sftp
      ? `${t.sftp.username}@${t.sftp.host}:${t.sftp.port} ${t.path}`
      : t.path;

export function PublishScreen({ initial }: { initial: PublishState }) {
  const [state, setState] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
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
      fingerprint?: string;
    } | null;
    if (!response.ok) {
      setProblem(answer?.error?.message ?? "That did not work.");
      return null;
    }
    return answer ?? {};
  }

  async function save() {
    if (!editing) return;
    const sftp = editing.kind === "sftp";
    const answer = await post({
      action: "save",
      ...(editing.id ? { id: editing.id } : {}),
      kind: editing.kind,
      label: editing.label,
      path: editing.path,
      ...(sftp
        ? {
            host: editing.host,
            port: editing.port,
            username: editing.username,
            auth: editing.auth,
            hostKey: editing.confirmed ? editing.seen : editing.hostKey,
            // A secret left empty keeps the saved one; only what was typed is sent.
            ...(editing.password ? { password: editing.password } : {}),
            ...(editing.privateKey ? { privateKey: editing.privateKey } : {}),
            ...(editing.passphrase ? { passphrase: editing.passphrase } : {}),
          }
        : {}),
    });
    if (answer) {
      setNote(`${editing.label} is saved.`);
      setEditing(null);
      await refresh();
    }
  }

  async function check() {
    if (!editing) return;
    setNote("Checking the server…");
    const answer = await post({ action: "probe", host: editing.host, port: editing.port });
    setNote("");
    if (answer?.fingerprint) setEditing({ ...editing, seen: answer.fingerprint, confirmed: false });
  }

  async function run(target: PublicPublishTarget) {
    setNote("");
    if (await post({ action: "run", id: target.id })) {
      setNote(`Publishing to ${target.label}…`);
      await refresh();
    }
  }

  async function remove(target: PublicPublishTarget) {
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
                    <code>{where(t, state.zipFolder)}</code>
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
                    <Button onPress={() => setEditing(draftOf(t))}>Edit</Button>{" "}
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
        <Button onPress={() => setEditing(blank())}>Add a place</Button>
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
                <option value="sftp">An SFTP server</option>
              </select>
            </label>
          </p>
          {editing.kind === "sftp" ? (
            <>
              <p>
                <label>
                  Server address
                  <br />
                  <input
                    value={editing.host}
                    placeholder="sftp.example.com"
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        host: event.target.value,
                        seen: "",
                        confirmed: false,
                      })
                    }
                  />
                </label>{" "}
                <label>
                  Port
                  <br />
                  <input
                    value={editing.port}
                    inputMode="numeric"
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        port: event.target.value,
                        seen: "",
                        confirmed: false,
                      })
                    }
                  />
                </label>
              </p>
              <p>
                <Button isDisabled={editing.host.trim() === ""} onPress={() => void check()}>
                  Check the server
                </Button>
                <br />
                {editing.seen ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={editing.confirmed}
                      onChange={(event) =>
                        setEditing({ ...editing, confirmed: event.target.checked })
                      }
                    />{" "}
                    The server shows the fingerprint <code>{editing.seen}</code>. This is my server:
                    trust it.
                  </label>
                ) : editing.hostKey ? (
                  <small>
                    The saved fingerprint is <code>{editing.hostKey}</code>. Check the server again
                    if it was changed on purpose.
                  </small>
                ) : (
                  <small>
                    Check the server first. Its fingerprint is shown here, and you confirm it is
                    yours, so a different machine at the same address is never trusted.
                  </small>
                )}
              </p>
              <p>
                <label>
                  User name
                  <br />
                  <input
                    value={editing.username}
                    autoComplete="off"
                    onChange={(event) => setEditing({ ...editing, username: event.target.value })}
                  />
                </label>
              </p>
              <p>
                <label>
                  Sign in with
                  <br />
                  <select
                    value={editing.auth}
                    onChange={(event) =>
                      setEditing({ ...editing, auth: event.target.value as "password" | "key" })
                    }
                  >
                    <option value="password">A password</option>
                    <option value="key">A private key</option>
                  </select>
                </label>
              </p>
              {editing.auth === "password" ? (
                <p>
                  <label>
                    Password
                    <br />
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={editing.password}
                      placeholder={editing.has.password ? "Leave empty to keep the saved one" : ""}
                      onChange={(event) => setEditing({ ...editing, password: event.target.value })}
                    />
                  </label>
                  <br />
                  <small>
                    {editing.has.password
                      ? "One is saved. It is never shown again."
                      : "It is saved sealed, and never shown again."}
                  </small>
                </p>
              ) : (
                <>
                  <p>
                    <label>
                      Private key
                      <br />
                      <textarea
                        rows={4}
                        value={editing.privateKey}
                        placeholder={
                          editing.has.privateKey
                            ? "Leave empty to keep the saved one"
                            : "-----BEGIN OPENSSH PRIVATE KEY-----"
                        }
                        onChange={(event) =>
                          setEditing({ ...editing, privateKey: event.target.value })
                        }
                      />
                    </label>
                  </p>
                  <p>
                    <label>
                      Passphrase of the key (if it has one)
                      <br />
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={editing.passphrase}
                        placeholder={
                          editing.has.passphrase ? "Leave empty to keep the saved one" : ""
                        }
                        onChange={(event) =>
                          setEditing({ ...editing, passphrase: event.target.value })
                        }
                      />
                    </label>
                  </p>
                </>
              )}
            </>
          ) : null}
          <p>
            <label>
              {editing.kind === "zip"
                ? "File name"
                : editing.kind === "sftp"
                  ? "Folder on the server"
                  : "Folder (the whole path)"}
              <br />
              <input
                value={editing.path}
                placeholder={
                  editing.kind === "zip"
                    ? "site.zip"
                    : editing.kind === "sftp"
                      ? "/var/www/site or public_html"
                      : "/var/www/site"
                }
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
