"use client";
// Tools > Plugins: the plugins of the site, and adding one from a plugin file (made with `oks pack`). The owner reads
// what the plugin asks for in plain words and approves all of it or only some (spec 04, sections 4 and 10).
import { Modal } from "@oks-page/admin";
import { Alert, Button } from "oks-ui";
import { useState } from "react";
import type { PluginInfo, PluginPreview } from "./plugin-admin";
import { PluginSettingsForm } from "./plugin-settings-form";

const RISK: Record<string, { word: string; kind: string }> = {
  low: { word: "Low risk", kind: "published" },
  medium: { word: "Medium risk", kind: "draft" },
  high: { word: "High risk", kind: "danger" },
};

const BUNDLED = [
  { id: "forms", name: "Forms", line: "Contact forms for your pages." },
  { id: "business", name: "Business", line: "Your details, opening hours and a payment link." },
];

/** What the row says about a plugin: it is "Limited" when it is on but not everything it asked for was approved. */
function stateOf(p: PluginInfo): { word: string; kind: string } {
  if (p.status === "switched_off") return { word: STATUS.switched_off, kind: "warn" };
  if (p.status !== "enabled") return { word: STATUS.disabled, kind: "off" };
  return p.permissions.some((x) => !x.approved)
    ? { word: "Limited", kind: "warn" }
    : { word: STATUS.enabled, kind: "on" };
}

/** "every 5 minutes", "every hour", "every 3 days". */
function every(minutes: number): string {
  const unit = (n: number, word: string) => (n === 1 ? `every ${word}` : `every ${n} ${word}s`);
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

const when = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

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
  const [removing, setRemoving] = useState<PluginInfo | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  function closeAdd() {
    setOpen(false);
    setAdding(null);
    setProblem(null);
  }

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

  async function addBundled(name: string, title: string) {
    setProblem(null);
    const response = await fetch("/api/admin/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "bundled", name }),
    });
    const body = (await response.json().catch(() => null)) as {
      plugin?: PluginPreview;
      file?: string;
      source?: string;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.plugin || !body.file) {
      setAdding(null);
      setProblem(body?.error?.message ?? `${title} could not be read.`);
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
    setOpen(false);
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

  const limited = plugins.filter((p) => stateOf(p).word === "Limited");
  const attention = [
    ...notices,
    ...limited.map((p) => `${p.name} is missing a permission, so a part of it does not work.`),
  ];
  const chosen = adding?.preview ?? null;
  return (
    <section aria-labelledby="plugins-heading" className="oks-bare">
      <h2 id="plugins-heading" className="oks-sr-only">
        Installed plugins
      </h2>
      <div className="oks-list-head">
        <p className="oks-list-summary">
          Add features to your site. Each plugin gets only the permissions you approve.
        </p>
        <div className="oks-list-actions">
          <Button
            color="primary"
            onPress={() => {
              setProblem(null);
              setNote("");
              setAdding(null);
              setOpen(true);
            }}
          >
            Add plugin
          </Button>
        </div>
      </div>
      {limitsNote ? <Alert color="warning" title="Limits" description={limitsNote} /> : null}
      {problem && !open ? <Alert color="danger" title="Not done" description={problem} /> : null}
      {attention.length > 0 ? (
        <div className="oks-attention" role="region" aria-label="Plugins that need your attention">
          <strong>A plugin needs attention</strong>
          <ul>
            {attention.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="oks-status-line" role="status">
        {note}
      </p>
      {plugins.length === 0 ? (
        <p>No plugins are installed.</p>
      ) : (
        <div className="oks-list">
          <div className="oks-list-scroll">
            <table className="oks-plugins" aria-label="Installed plugins">
              <thead>
                <tr>
                  <th scope="col">Plugin</th>
                  <th scope="col">Status</th>
                  <th scope="col">Permissions</th>
                  <th scope="col">Version</th>
                  <th scope="col">On</th>
                  <th scope="col">
                    <span className="oks-sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              {plugins.map((p) => {
                const state = stateOf(p);
                const approvedCount = p.permissions.filter((x) => x.approved).length;
                const missing = p.permissions.filter((x) => !x.approved);
                const isShown = shown === p.id;
                return (
                  <tbody key={p.id}>
                    <tr>
                      <th scope="row">
                        <span className="oks-plugin-name">
                          <span className="oks-plugin-tile" aria-hidden="true">
                            {p.name.charAt(0).toUpperCase()}
                          </span>
                          <span>
                            <span className="oks-list-title">{p.name}</span>
                            <span className="oks-list-path">
                              {p.author ? `By ${p.author}. ` : ""}
                              {p.description}
                            </span>
                            {p.jobs.length > 0 ? (
                              <span className="oks-list-path">
                                Runs by itself:{" "}
                                {p.jobs
                                  .map(
                                    (j) =>
                                      `${j.name}, ${every(j.everyMinutes)}` +
                                      (j.last
                                        ? `; last ${when(j.last.at)}${j.last.ok ? " (worked)" : ` (did not work${j.last.error ? `: ${j.last.error}` : ""})`}`
                                        : "; not run yet") +
                                      (j.next ? `; next ${when(j.next)}` : ""),
                                  )
                                  .join(". ")}
                                .
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </th>
                      <td>
                        <span className="oks-dot-state" data-kind={state.kind}>
                          {state.word}
                        </span>
                      </td>
                      <td>
                        <span>
                          {p.permissions.length === 0
                            ? "None asked"
                            : `${approvedCount} of ${p.permissions.length} approved`}
                        </span>
                        {missing.length > 0 ? (
                          <span className="oks-missing">
                            Missing: {missing.map((x) => x.words.toLowerCase()).join(", ")}
                          </span>
                        ) : null}
                      </td>
                      <td>{p.version}</td>
                      <td>
                        <button
                          type="button"
                          role="switch"
                          className="oks-switch"
                          aria-checked={p.status === "enabled"}
                          aria-label={`${p.name} is switched on`}
                          onClick={() => void toggle(p)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="oks-row-more"
                          aria-expanded={isShown}
                          aria-label={`Details of ${p.name}`}
                          onClick={() => setShown(isShown ? null : p.id)}
                        >
                          <span aria-hidden="true">{isShown ? "‹" : "›"}</span>
                        </button>
                      </td>
                    </tr>
                    {isShown ? (
                      <tr className="oks-detail-row">
                        <td colSpan={6}>
                          {p.permissions.length === 0 ? (
                            <p>It asks for no permissions.</p>
                          ) : (
                            <ul>
                              {p.permissions.map((x) => (
                                <li key={x.permission}>
                                  {x.words}
                                  {x.approved ? "" : " (not approved)"}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="oks-detail-actions">
                            {p.pages.map((page) => (
                              <a
                                key={page.id}
                                className="oks-link-button"
                                href={`/admin/tools/plugins/${p.id}/${page.id}`}
                              >
                                {page.title}
                              </a>
                            ))}
                            {p.hasSettings ? (
                              <Button onPress={() => setEditing(editing === p.id ? null : p.id)}>
                                Settings
                              </Button>
                            ) : null}
                            <Button color="danger" onPress={() => setRemoving(p)}>
                              Remove
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                );
              })}
            </table>
          </div>
        </div>
      )}
      <p className="oks-list-path">
        Plugins run in a sandbox. They cannot reach your files, your database or other plugins.
      </p>
      {editing && plugins.some((p) => p.id === editing) ? (
        <PluginSettingsForm
          key={editing}
          id={editing}
          name={plugins.find((p) => p.id === editing)?.name ?? editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <Modal
        isOpen={open}
        onClose={closeAdd}
        title={chosen ? `Add ${chosen.name}` : "Add a plugin"}
      >
        {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
        {note && open ? <p role="status">{note}</p> : null}
        {adding && chosen ? (
          <form
            aria-label="Add this plugin"
            className="oks-approve"
            onSubmit={(event) => {
              event.preventDefault();
              void install();
            }}
          >
            <p className="oks-list-path">
              Version {chosen.version}, by {chosen.author}. {chosen.description}
              {adding.source === "file" ? "" : ` From ${adding.source.slice(4)}.`}
            </p>
            {chosen.installed ? (
              <Alert
                color="warning"
                title="Already installed"
                description="This plugin is already installed. Remove it first to add this file."
              />
            ) : null}
            {chosen.permissions.length === 0 ? (
              <p>It asks for no permissions.</p>
            ) : (
              <fieldset>
                <legend>
                  {chosen.name} asks for {chosen.permissions.length}{" "}
                  {chosen.permissions.length === 1 ? "permission" : "permissions"}. Approve all of
                  them, or only the ones you are comfortable with.
                </legend>
                {chosen.permissions.map((p) => (
                  <div key={p.permission} className="oks-permission">
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
                      />
                      <span>{p.words}</span>
                    </label>
                    <code>{p.permission}</code>
                    <span className="oks-chip" data-status={RISK[p.risk]?.kind}>
                      {RISK[p.risk]?.word}
                    </span>
                  </div>
                ))}
              </fieldset>
            )}
            <p className="oks-info-box">
              <strong>If you leave one off, the plugin still installs.</strong> The parts that need
              it will not work, and you will see a note on the Plugins page.
            </p>
            <div className="oks-dialog-foot">
              {chosen.permissions.length > 0 ? (
                <button
                  type="button"
                  className="oks-text-button"
                  onClick={() => setApproved(chosen.permissions.map((p) => p.permission))}
                >
                  Select all
                </button>
              ) : (
                <span />
              )}
              <div>
                <Button onPress={closeAdd}>Cancel</Button>
                <Button type="submit" color="primary" isDisabled={chosen.installed}>
                  {chosen.permissions.length === 0
                    ? "Install"
                    : `Approve ${approved.length} of ${chosen.permissions.length} and install`}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <div className="oks-add-plugin">
            <p className="oks-list-path">
              A plugin adds a feature to your site. Each one runs in its own protected space and can
              only do what you approve. Add only plugins from an author you trust.
            </p>
            {BUNDLED.filter((b) => !plugins.some((p) => p.id === b.id)).map((b) => (
              <div key={b.id} className="oks-bundled">
                <span>
                  <span className="oks-list-title">{b.name}</span>
                  <span className="oks-list-path">Ready-made. {b.line}</span>
                </span>
                <Button onPress={() => void addBundled(b.id, b.name)}>{`Add ${b.name}`}</Button>
              </div>
            ))}
            <label className="oks-field-block">
              <span>Plugin file</span>
              <input
                type="file"
                accept=".oksplugin,application/json"
                onChange={(event) => {
                  void choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <form
              aria-label="Add a plugin from npm"
              className="oks-npm"
              onSubmit={(event) => {
                event.preventDefault();
                void lookUp();
              }}
            >
              <label className="oks-field-block">
                <span>npm package name</span>
                <input value={npmName} onChange={(event) => setNpmName(event.target.value)} />
              </label>
              <label className="oks-field-block">
                <span>Version (empty: the latest)</span>
                <input value={npmVersion} onChange={(event) => setNpmVersion(event.target.value)} />
              </label>
              <Button type="submit" isDisabled={npmName.trim() === ""}>
                Look up on npm
              </Button>
            </form>
          </div>
        )}
      </Modal>
      <Modal
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        role="alertdialog"
        title="Remove this plugin?"
        actions={
          <>
            <Button onPress={() => setRemoving(null)}>No</Button>
            <Button color="danger" onPress={() => removing && void remove(removing)}>
              Yes, remove
            </Button>
          </>
        }
      >
        <p>{removing?.name} and its data are removed. This cannot be undone.</p>
      </Modal>
    </section>
  );
}
