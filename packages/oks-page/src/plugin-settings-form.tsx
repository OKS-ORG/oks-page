"use client";
// The settings of one plugin (spec 04, section 9): the form comes from what the plugin declared. A secret (an API key) is
// never shown again: the form says that one is saved and shows at most its last four characters; leaving it empty keeps it.
import { Alert, Button } from "oks-ui";
import { useEffect, useState } from "react";
import type { PluginSettingsView } from "./plugin-admin";

interface SecretView {
  set: boolean;
  hint: string;
}

export function PluginSettingsForm({
  id,
  name,
  onClose,
}: {
  id: string;
  name: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Record<string, boolean>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    const response = await fetch(`/api/admin/plugins?settings=${encodeURIComponent(id)}`);
    const body = (await response.json().catch(() => null)) as {
      settings?: PluginSettingsView;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.settings) {
      setProblem(body?.error?.message ?? "The settings could not be loaded.");
      return;
    }
    setView(body.settings);
    setValues(body.settings.values);
    setTyped({});
    setRemoved({});
  }

  useEffect(() => {
    void load();
  }, [id]);

  async function save() {
    if (!view) return;
    setProblem(null);
    setNote("Saving…");
    const send: Record<string, unknown> = {};
    for (const f of view.fields) {
      if (f.type === "secret") {
        // Left empty: the saved one stays. Typed: it replaces it. "Remove": it is deleted.
        if (removed[f.key]) send[f.key] = "";
        else if ((typed[f.key] ?? "") !== "") send[f.key] = typed[f.key];
      } else if (f.type === "boolean") send[f.key] = values[f.key] === true;
      else if (f.type === "number") {
        const v = values[f.key];
        send[f.key] = v === null || v === undefined || v === "" ? null : Number(v);
      } else send[f.key] = typeof values[f.key] === "string" ? values[f.key] : "";
    }
    const response = await fetch("/api/admin/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "saveSettings", id, values: send }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setNote("");
      setProblem(body?.error?.message ?? "The settings could not be saved.");
      return;
    }
    setNote(`The settings of ${name} are saved.`);
    await load();
  }

  return (
    <form
      aria-label={`Settings of ${name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>Settings of {name}</h3>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p role="status" style={{ minBlockSize: "1.5rem" }}>
        {note}
      </p>
      {view === null ? (
        problem ? null : (
          <p>Loading…</p>
        )
      ) : (
        <>
          {view.fields.map((f) => {
            const secret =
              f.type === "secret" ? (values[f.key] as SecretView | undefined) : undefined;
            return (
              <p key={f.key}>
                {f.type === "boolean" ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={values[f.key] === true}
                      onChange={(event) => setValues({ ...values, [f.key]: event.target.checked })}
                    />{" "}
                    {f.label}
                  </label>
                ) : f.type === "secret" ? (
                  <>
                    <label>
                      {f.label}
                      <br />
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={typed[f.key] ?? ""}
                        placeholder={secret?.set ? "Leave empty to keep the saved one" : ""}
                        onChange={(event) => setTyped({ ...typed, [f.key]: event.target.value })}
                      />
                    </label>
                    <br />
                    <small>
                      {secret?.set
                        ? `One is saved (${secret.hint}). It is never shown again.`
                        : "None is saved."}
                    </small>
                    {secret?.set ? (
                      <label style={{ marginInlineStart: "1rem" }}>
                        <input
                          type="checkbox"
                          checked={removed[f.key] === true}
                          onChange={(event) =>
                            setRemoved({ ...removed, [f.key]: event.target.checked })
                          }
                        />{" "}
                        Remove the saved one
                      </label>
                    ) : null}
                  </>
                ) : (
                  <label>
                    {f.label}
                    <br />
                    <input
                      type={f.type === "number" ? "number" : "text"}
                      step={f.type === "number" ? "any" : undefined}
                      value={
                        typeof values[f.key] === "string" || typeof values[f.key] === "number"
                          ? String(values[f.key])
                          : ""
                      }
                      onChange={(event) => setValues({ ...values, [f.key]: event.target.value })}
                    />
                  </label>
                )}
              </p>
            );
          })}
          <p>
            <Button type="submit" color="primary">
              Save settings
            </Button>{" "}
            <Button onPress={onClose}>Close</Button>
          </p>
        </>
      )}
    </form>
  );
}
