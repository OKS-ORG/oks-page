"use client";
// Settings > Licences: paste a key, see what each key allows, remove one. A key is checked on the site; nothing is sent.
import type { LicencePayload, LicenceState } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

interface Row {
  licence: LicencePayload;
  state: LicenceState;
}

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

const KIND: Record<LicencePayload["kind"], string> = {
  normal: "Normal",
  trial: "Trial",
  development: "Development",
};

const covers = (licence: LicencePayload): string =>
  licence.covers.includes("*") ? "Everything" : licence.covers.join(", ");

const updates = (licence: LicencePayload): string =>
  licence.updatesUntil
    ? licence.updatesUntil
    : licence.maxMajor
      ? `Lifetime for version ${licence.maxMajor}`
      : "No end date";

export function LicencesScreen({ initial, canCheck }: { initial: Row[]; canCheck: boolean }) {
  const [rows, setRows] = useState(initial);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Checking…");
    try {
      const response = await fetch("/api/admin/licences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const body = (await response.json().catch(() => null)) as { key?: Row } | null;
      if (!response.ok) throw new Error(failure(body, "The key could not be added."));
      if (body?.key) setRows((current) => [...current, body.key!]);
      setKey("");
      setNote("The key is added.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  async function remove(id: string) {
    setProblem(null);
    setNote("Removing…");
    try {
      const response = await fetch(`/api/admin/licences?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "The key could not be removed."));
      setRows((current) => current.filter((row) => row.licence.id !== id));
      setNote("The key is removed.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  return (
    <div className="oks-licences">
      {canCheck ? null : (
        <Alert
          color="warning"
          title="Keys cannot be checked yet"
          description="This version has no signing key built in, so no key can be added."
        />
      )}
      <p>
        A licence key unlocks updates for a paid plug-in or theme. It is checked on this site and
        nothing is sent to us. When a key ends, the plug-in or theme keeps working; only updates
        stop.
      </p>
      {rows.length === 0 ? (
        <p>No keys yet.</p>
      ) : (
        <table>
          <caption>Licence keys on this site</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Covers</th>
              <th scope="col">Sites</th>
              <th scope="col">Updates until</th>
              <th scope="col">What it allows</th>
              <th scope="col">
                <span className="oks-sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ licence, state }) => (
              <tr key={licence.id}>
                <th scope="row">
                  {licence.holder ? `${licence.id} (${licence.holder})` : licence.id}
                </th>
                <td>{KIND[licence.kind]}</td>
                <td>{covers(licence)}</td>
                <td>{licence.sites}</td>
                <td>{updates(licence)}</td>
                <td>{state.message}</td>
                <td>
                  <Button
                    type="button"
                    color="danger"
                    onClick={() => void remove(licence.id)}
                    aria-label={`Remove key ${licence.id}`}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={(event) => void add(event)}>
        <p>
          <label htmlFor="licence-key">Add a licence key</label>
          <br />
          <textarea
            id="licence-key"
            name="key"
            rows={4}
            cols={64}
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="OKS1...."
          />
        </p>
        <p>
          <Button color="primary" type="submit" disabled={key.trim() === ""}>
            Add key
          </Button>
        </p>
      </form>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>
    </div>
  );
}
