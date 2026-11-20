"use client";
// Tools > Plugins: the plugins of the site, and adding one from a plugin file (made with `oks pack`). The owner reads
// what the plugin asks for in plain words and approves all of it or only some (spec 04, sections 4 and 10).
import { Alert, Button } from "oks-ui";
import { useState } from "react";
import type { PluginInfo, PluginPreview } from "./plugin-admin";
import { PluginSettingsForm } from "./plugin-settings-form";

const RISK: Record<string, string> = { low: "", medium: " (medium risk)", high: " (HIGH RISK)" };

const STATUS: Record<PluginInfo["status"], string> = {
  enabled: "On",
  disabled: "Off",
  switched_off: "Switched off after problems",
};

export function PluginsScreen({
  initial,
  limitsNote,
  notices: firstNotices,
}: {
  initial: PluginInfo[];
  limitsNote: string | null;
  notices: string[];
}) {
  const [plugins, setPlugins] = useState(initial);
  const [notices, setNotices] = useState<string[]>(firstNotices);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<{
    text: string;
    preview: PluginPreview;
    source: string;
  } | null>(null);
  const [npmName, setNpmName] = useState("");
  const [npmVersion, setNpmVersion] = useState("");
  const [approved, setApproved] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/admin/plugins");
    const body = (await response.json().catch(() => null)) as {
      plugins?: PluginInfo[];
      notices?: string[];
    } | null;
    if (body?.plugins) setPlugins(body.plugins);
    setNotices(body?.notices ?? []);
  }

  async function choose(file: File | undefined) {
    setProblem(null);
    setNote("");
    if (!file) return;
    const text = await file.text();
    const response = await fetch("/api/admin/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "preview", file: text }),
    });
    const body = (await response.json().catch(() => null)) as {
      plugin?: PluginPreview;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.plugin) {
      setAdding(null);
      setProblem(body?.error?.message ?? "This file could not be read.");
      return;
    }
    setApproved(body.plugin.permissions.map((p) => p.permission));
    setAdding({ text, preview: body.plugin, source: "file" });
  }

  async function lookUp() {
    setProblem(null);
    setNote("Looking it up on npm…");
    const response = await fetch("/api/admin/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "npm", name: npmName, version: npmVersion }),
    });
    const body = (await response.json().catch(() => null)) as {
      plugin?: PluginPreview;
      file?: string;
      source?: string;
      error?: { message?: string };
    } | null;
    setNote("");
    if (!response.ok || !body?.plugin || !body.file) {
      setAdding(null);
      setProblem(body?.error?.message ?? "The package could not be looked up.");
      return;
    }
    setApproved(body.plugin.permissions.map((p) => p.permission));
    setAdding({ text: body.file, preview: body.plugin, source: body.source ?? "file" });
  }

  async function install() {
    if (!adding) return;
    setProblem(null);
    setNote("Adding…");
    const response = await fetch("/api/admin/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "install",
        file: adding.text,
        approved,
        source: adding.source,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
      running?: boolean;
    } | null;
    if (!response.ok) {
      setNote("");
      setProblem(body?.error?.message ?? "The plugin could not be added.");
      return;
    }
    setNote(
      body?.running === false
        ? `${adding.preview.name} is added, but the plugin sandbox could not start on this computer, so it is not running.`
        : `${adding.preview.name} is added and switched on.`,
    );
    setAdding(null);
    await refresh();
  }

  async function toggle(p: PluginInfo) {
    setProblem(null);
    const on = p.status !== "enabled";
    const response = await fetch("/api/admin/plugins", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: p.id, enabled: on }),
    });
    if (!response.ok) setProblem("The plugin could not be changed.");
    else setNote(`${p.name} is ${on ? "on" : "off"}.`);
    await refresh();
  }

  async function remove(p: PluginInfo) {
    setProblem(null);
    const response = await fetch(`/api/admin/plugins?id=${encodeURIComponent(p.id)}`, {
      method: "DELETE",
    });
    setRemoving(null);
    if (!response.ok) setProblem("The plugin could not be removed.");
    else setNote(`${p.name} is removed, with its data.`);
    await refresh();
  }

  return (
    <section aria-labelledby="plugins-heading">
      <h2 id="plugins-heading">Plugins</h2>
      <p>
        A plugin adds a feature to your site. Each one runs in its own protected space and can only
        do what you approve here. Add a plugin from a file made with <code>oks pack</code>, and only
        from an author you trust.
      </p>
      {limitsNote ? <Alert color="warning" title="Limits" description={limitsNote} /> : null}
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      {notices.map((n) => (
        <Alert key={n} color="warning" title="A plugin needs attention" description={n} />
      ))}
      <p style={{ minBlockSize: "1.5rem" }} role="status">
        {note}
      </p>
      <p>
        <label>
          Plugin file{" "}
          <input
            type="file"
            accept=".oksplugin,application/json"
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </p>
      <form
        aria-label="Add a plugin from npm"
        onSubmit={(event) => {
          event.preventDefault();
          void lookUp();
        }}
      >
        <p>
          <label>
            npm package name{" "}
            <input value={npmName} onChange={(event) => setNpmName(event.target.value)} />
          </label>{" "}
          <label>
            Version (empty: the latest){" "}
            <input value={npmVersion} onChange={(event) => setNpmVersion(event.target.value)} />
          </label>{" "}
          <Button type="submit" isDisabled={npmName.trim() === ""}>
            Look up on npm
          </Button>
        </p>
      </form>
      {adding ? (
        <form
          aria-label="Add this plugin"
          onSubmit={(event) => {
            event.preventDefault();
            void install();
          }}
        >
          <h3>
            Add {adding.preview.name} {adding.preview.version}
          </h3>
          <p>
            By {adding.preview.author}. {adding.preview.description}
            {adding.source === "file" ? "" : ` From ${adding.source.slice(4)}.`}
          </p>
          {adding.preview.installed ? (
            <Alert
              color="warning"
              title="Already installed"
              description="This plugin is already installed. Remove it first to add this file."
            />
          ) : null}
          {adding.preview.permissions.length === 0 ? (
            <p>It asks for no permissions.</p>
          ) : (
            <fieldset>
              <legend>It would like to:</legend>
              {adding.preview.permissions.map((p) => (
                <p key={p.permission}>
                  <label>
                    <input
                      type="checkbox"
                      checked={approved.includes(p.permission)}
                      onChange={(event) =>
                        setApproved((all) =>
                          event.target.checked
                            ? [...all, p.permission]
                            : all.filter((x) => x !== p.permission),
                        )
                      }
                    />{" "}
                    {p.words}
                    {RISK[p.risk]}
                  </label>{" "}
                  <small>({p.permission})</small>
                </p>
              ))}
              <p>
                You can approve only some of these. A plugin works in a smaller way without the ones
                you leave out.
              </p>
            </fieldset>
          )}
          <p>
            <Button type="submit" color="primary" isDisabled={adding.preview.installed}>
              Add plugin
            </Button>{" "}
            <Button onPress={() => setAdding(null)}>Cancel</Button>
          </p>
        </form>
      ) : null}
      {plugins.length === 0 ? (
        <p>No plugins are installed.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Plugin</th>
              <th scope="col">Version</th>
              <th scope="col">State</th>
              <th scope="col">Permissions</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  {p.name}
                  <br />
                  <small>
                    {p.author ? `By ${p.author}. ` : ""}
                    {p.description}
                  </small>
                </th>
                <td>{p.version}</td>
                <td>{STATUS[p.status]}</td>
                <td>
                  {p.permissions.length === 0 ? (
                    "None"
                  ) : (
                    <ul style={{ margin: 0, paddingInlineStart: "1rem" }}>
                      {p.permissions.map((x) => (
                        <li key={x.permission}>
                          {x.words}
                          {x.approved ? "" : " (not approved)"}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {p.hasSettings ? (
                    <>
                      <Button onPress={() => setEditing(editing === p.id ? null : p.id)}>
                        Settings
                      </Button>{" "}
                    </>
                  ) : null}
                  <Button onPress={() => void toggle(p)}>
                    {p.status === "enabled" ? "Switch off" : "Switch on"}
                  </Button>{" "}
                  {removing === p.id ? (
                    <>
                      Remove {p.name} and its data?{" "}
                      <Button onPress={() => void remove(p)}>Yes, remove</Button>{" "}
                      <Button onPress={() => setRemoving(null)}>No</Button>
                    </>
                  ) : (
                    <Button onPress={() => setRemoving(p.id)}>Remove</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && plugins.some((p) => p.id === editing) ? (
        <PluginSettingsForm
          key={editing}
          id={editing}
          name={plugins.find((p) => p.id === editing)?.name ?? editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
