"use client";
// Tools > Privacy requests (spec 18, section 5): enter an email address, see what the site keeps that is linked to it,
// download it as a ZIP, or delete it. Deleting asks first and says how many items it will remove. The address is sent in the
// body of a request, never in a web address.
import { Alert, Button } from "oks-ui";
import { useEffect, useState } from "react";
import type { PrivacyFindResult } from "./privacy-requests";
import type { OpenRequest } from "./privacy-visitor";

async function post(action: string, email: string): Promise<Response> {
  return fetch("/api/admin/privacy-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, email }),
  });
}

const problemOf = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
};

export function PrivacyRequestsScreen() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<PrivacyFindResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<{
    waiting: number;
    open: OpenRequest[];
    answered: number;
  } | null>(null);
  const [origin, setOrigin] = useState("");

  async function loadRequests() {
    const response = await post("requests", "");
    if (!response.ok) return;
    setAsked((await response.json()) as { waiting: number; open: OpenRequest[]; answered: number });
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    void loadRequests();
  }, []);

  async function answer(id: string) {
    setProblem(null);
    const response = await fetch("/api/admin/privacy-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "answer", id }),
    });
    if (!response.ok) {
      setProblem(await problemOf(response, "That did not work."));
      return;
    }
    setNote("Marked as answered. The address is no longer kept for this request.");
    await loadRequests();
  }

  async function find(address = email) {
    setProblem(null);
    setBusy(true);
    const response = await post("find", address);
    setBusy(false);
    if (!response.ok) {
      setResult(null);
      setProblem(await problemOf(response, "The search did not work."));
      return;
    }
    const body = (await response.json()) as { result: PrivacyFindResult };
    setResult(body.result);
    setAsking(false);
  }

  async function download() {
    if (!result) return;
    setProblem(null);
    const response = await post("export", result.email);
    if (!response.ok) {
      setProblem(await problemOf(response, "The export did not work."));
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download =
      /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
      "personal-data.zip";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNote("The ZIP file was downloaded.");
  }

  async function remove() {
    if (!result) return;
    setProblem(null);
    setAsking(false);
    const response = await post("delete", result.email);
    if (!response.ok) {
      setProblem(await problemOf(response, "The deletion did not work."));
      return;
    }
    const done = (await response.json()) as {
      items: number;
      files: number;
      emails: number;
      account: boolean;
    };
    setNote(
      `Deleted ${done.items} item${done.items === 1 ? "" : "s"}, ${done.files} file${done.files === 1 ? "" : "s"} and ${done.emails} email record${done.emails === 1 ? "" : "s"}.` +
        (done.account ? " The person's account is still there: remove it in Users." : ""),
    );
    await find(result.email);
  }

  return (
    <section aria-labelledby="privacy-requests-heading">
      <h2 id="privacy-requests-heading">Privacy requests</h2>
      <p>
        Someone asked to see or delete what the site keeps about them? Enter their email address.
        You get a list of what is linked to it, a ZIP file you can send them, and a button to delete
        it. Check that the person is who they say they are before you send or delete anything. The
        answer is due within 30 days. Every request is written in the audit log, without the data.
      </p>
      <section aria-labelledby="visitor-requests-heading">
        <h3 id="visitor-requests-heading">Requests from visitors</h3>
        <p>
          Visitors can ask for a copy of their data, or for it to be deleted, at{" "}
          <strong>{origin ? `${origin}/privacy-request` : "/privacy-request"}</strong>. They get an
          email with a link and confirm there; only confirmed requests appear here. You have 30 days
          to answer.
        </p>
        {asked && asked.waiting > 0 ? (
          <p>
            {asked.waiting} request{asked.waiting === 1 ? " is" : "s are"} waiting for the person to
            confirm.
          </p>
        ) : null}
        {asked && asked.open.length === 0 ? <p>No confirmed request is waiting for you.</p> : null}
        {asked && asked.open.length > 0 ? (
          <ul aria-label="Confirmed requests">
            {asked.open.map((r) => (
              <li key={r.id}>
                <p>
                  <strong>
                    {r.kind === "export"
                      ? "Wants a copy of their data"
                      : "Wants their data deleted"}
                  </strong>
                  : {r.email ?? "(the address can no longer be read)"}.
                  <br />
                  Confirmed {new Date(r.confirmedAt).toISOString().slice(0, 10)}. Answer by{" "}
                  <strong>{new Date(r.dueAt).toISOString().slice(0, 10)}</strong>.
                </p>
                <p>
                  {r.email ? (
                    <>
                      <Button
                        aria-label={`Look up ${r.email}`}
                        onPress={() => {
                          setEmail(r.email!);
                          setNote("");
                          void find(r.email!);
                        }}
                      >
                        Look up this address
                      </Button>{" "}
                    </>
                  ) : null}
                  <Button
                    aria-label={`Mark the request of ${r.email ?? "this person"} as answered`}
                    onPress={() => void answer(r.id)}
                  >
                    Mark as answered
                  </Button>
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {asked && asked.answered > 0 ? (
          <p>
            {asked.answered} answered request{asked.answered === 1 ? "" : "s"} kept as a record.
          </p>
        ) : null}
      </section>
      <h3>Look up an address</h3>
      <form
        aria-label="Find a person's data"
        onSubmit={(event) => {
          event.preventDefault();
          setNote("");
          void find();
        }}
      >
        <p>
          <label>
            Email address
            <br />
            <input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={{ inlineSize: "24rem", maxInlineSize: "100%" }}
            />
          </label>{" "}
          <Button type="submit" color="primary" isDisabled={busy || email.trim() === ""}>
            Find
          </Button>
        </p>
      </form>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status" style={{ minBlockSize: "1.5rem" }}>
        {note}
      </p>
      {result ? (
        <div>
          <h3>Found for {result.email}</h3>
          {result.groups.length === 0 ? <p>Nothing is kept for this address.</p> : null}
          {result.groups.map((g) => (
            <section key={`${g.plugin ?? ""}:${g.sourceId}`} aria-label={g.label}>
              <h4>
                {g.label} ({g.total})
              </h4>
              {g.note ? <p>{g.note}</p> : null}
              <div style={{ overflowX: "auto" }}>
                <table>
                  <caption className="oks-sr-only">{g.label}</caption>
                  <thead>
                    <tr>
                      {(g.items[0]?.cells ?? []).map((c) => (
                        <th key={c.label} scope="col">
                          {c.label}
                        </th>
                      ))}
                      {g.items.some((i) => i.files.length > 0) ? <th scope="col">Files</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((item) => (
                      <tr key={item.key}>
                        {item.cells.map((c, n) => (
                          <td key={n} style={{ verticalAlign: "top" }}>
                            {c.text}
                          </td>
                        ))}
                        {g.items.some((i) => i.files.length > 0) ? (
                          <td style={{ verticalAlign: "top" }}>
                            {item.files.map((f) => f.name).join(", ")}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {g.total > g.items.length ? <p>Showing the first {g.items.length}.</p> : null}
            </section>
          ))}
          {result.groups.length > 0 ? (
            <p>
              <Button onPress={() => void download()}>Download everything as a ZIP file</Button>{" "}
              {result.deletable > 0 ? (
                asking ? (
                  <>
                    <span>
                      Delete {result.deletable} item{result.deletable === 1 ? "" : "s"} for
                      good?{" "}
                    </span>
                    <Button color="danger" onPress={() => void remove()}>
                      Yes, delete
                    </Button>{" "}
                    <Button onPress={() => setAsking(false)}>Cancel</Button>
                  </>
                ) : (
                  <Button color="danger" onPress={() => setAsking(true)}>
                    Delete these items
                  </Button>
                )
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
