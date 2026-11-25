"use client";
// Tools > Connection (spec 11, section 6): make a connection code for an agency's dashboard, and remove keys.
import type { ConnectorKeyView } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/connector", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    code?: string;
    error?: { message?: string };
  } | null;
  return {
    ok: response.ok && data?.ok === true,
    data,
    message: data?.error?.message ?? "That did not work.",
  };
}

export function ConnectorScreen({ keys }: { keys: ConnectorKeyView[] }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");

  async function make() {
    setProblem("");
    const r = await post({ action: "make" });
    if (!r.ok) return setProblem(r.message);
    setCode(r.data?.code ?? "");
    router.refresh();
  }
  async function remove(id: string) {
    setProblem("");
    const r = await post({ action: "remove", id });
    if (!r.ok) return setProblem(r.message);
    router.refresh();
  }

  return (
    <>
      <p>
        An agency that looks after this site can see its status in its own dashboard: the version,
        whether email and two-factor are set up, the free disk space and the page and visit counts.
        It can never read your pages, your users or any secret. To allow it, make a connection code
        and give it to the agency.
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p>
        <button type="button" onClick={() => void make()}>
          Make a connection code
        </button>
      </p>
      {code ? (
        <div role="status">
          <p>
            <strong>Copy this code now. It is shown only once</strong>; the site keeps the key but
            not a copy of the code. Send it to the agency by a private way, not by an open chat.
          </p>
          <textarea
            readOnly
            rows={4}
            value={code}
            aria-label="The connection code"
            style={{ inlineSize: "100%", maxInlineSize: "46rem" }}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      <h2>Keys</h2>
      {keys.length === 0 ? (
        <p>No key. The connection is off, and the site answers no dashboard.</p>
      ) : (
        <>
          <p>
            A key that is removed stops working at once. To change a key without a break: make a new
            code, let the agency connect with it, then remove the old key.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Made on</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <th scope="row">{k.id}</th>
                  <td>{day(k.createdAt)}</td>
                  <td>
                    <button type="button" onClick={() => void remove(k.id)}>
                      Remove key {k.id}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
