"use client";
// The Users screen: the people of the site with their roles, a form to invite someone (it makes a link to pass on), and the
// invitations that are waiting. The server decides every change again; the last administrator cannot be demoted or removed.
import { ListTable, Modal } from "@oks-page/admin";
import type { Invitation, Member, RoleChoice } from "@oks-page/core";
import { Alert, Button, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";
import { formatWhen } from "./time-format";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

const ROW: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.75rem",
  margin: "0.75rem 0",
};
const CONTROL: React.CSSProperties = { minBlockSize: "36px", paddingInline: "0.5rem" };
const DAYS = [1, 7, 14, 30];

async function send(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; body: unknown }> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: response.ok, body: await response.json().catch(() => null) };
  } catch {
    return {
      ok: false,
      body: {
        error: { message: "The site could not be reached. Check your connection and try again." },
      },
    };
  }
}

interface MemberRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  member: Member;
}
interface InviteRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  invitation: Invitation;
}

export function UsersScreen({
  you,
  members,
  roles,
  invitations,
  timeZone,
  emailWorks = false,
}: {
  you: string;
  members: Member[];
  roles: RoleChoice[];
  invitations: Invitation[];
  timeZone: string | null;
  /** When email works, the invitation can also go out by email (spec 13). */
  emailWorks?: boolean;
}) {
  const label = (key: string) => roles.find((r) => r.key === key)?.label ?? key;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState(
    roles.find((r) => r.key === "editor")?.key ?? roles[0]?.key ?? "",
  );
  const [days, setDays] = useState("7");
  const [byEmail, setByEmail] = useState(emailWorks);
  const [inviteProblem, setInviteProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{
    link: string;
    invitation: Invitation;
    emailed?: boolean;
  } | null>(null);
  const [waiting, setWaiting] = useState<Invitation[]>(invitations);
  const [copied, setCopied] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [cancelling, setCancelling] = useState<Invitation | null>(null);

  const when = (ms: number) => formatWhen(new Date(ms).toISOString(), timeZone);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setInviteProblem(null);
    setMade(null);
    setCopied("");
    setBusy(true);
    const result = await send("/api/admin/users", "POST", {
      name,
      email,
      roleKey,
      days: Number(days),
      sendEmail: emailWorks && byEmail,
    });
    setBusy(false);
    if (!result.ok)
      return setInviteProblem(failure(result.body, "The invitation could not be made."));
    const body = result.body as { link: string; invitation: Invitation; emailed?: boolean };
    setMade(body);
    setWaiting((now) => [...now, body.invitation]);
    setName("");
    setEmail("");
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("Copied.");
    } catch {
      setCopied("It could not be copied. Select the link and copy it by hand.");
    }
  }

  async function changeRole(member: Member, role: string) {
    setProblem(null);
    setNote("");
    const result = await send(`/api/admin/users/${member.userId}`, "PATCH", { role });
    if (!result.ok) {
      setProblem(failure(result.body, "The role could not be changed."));
      return;
    }
    window.location.reload();
  }

  async function remove() {
    if (!removing) return;
    setProblem(null);
    const result = await send(`/api/admin/users/${removing.userId}`, "DELETE");
    if (!result.ok) {
      setProblem(failure(result.body, "The person could not be removed."));
      setRemoving(null);
      return;
    }
    window.location.reload();
  }

  async function cancel() {
    if (!cancelling) return;
    const result = await send(`/api/admin/invitations/${cancelling.id}`, "DELETE");
    if (!result.ok) {
      setProblem(failure(result.body, "The invitation could not be cancelled."));
    } else {
      setWaiting((now) => now.filter((i) => i.id !== cancelling.id));
      if (made?.invitation.id === cancelling.id) setMade(null);
      setNote(`The invitation for ${cancelling.name} is cancelled. Its link no longer works.`);
    }
    setCancelling(null);
  }

  const memberRows: MemberRow[] = members.map((m) => ({
    id: m.userId,
    name: m.name,
    email: m.email,
    member: m,
  }));
  const inviteRows: InviteRow[] = waiting.map((i) => ({
    id: i.id,
    name: i.name,
    email: i.email,
    invitation: i,
  }));

  return (
    <>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>

      <section aria-labelledby="people-heading">
        <h2 id="people-heading">People</h2>
        <ListTable
          label="People of the site"
          rows={memberRows}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "name",
              header: "Name",
              sortable: true,
              render: (row) => (row.member.userId === you ? `${row.name} (you)` : row.name),
            },
            { key: "email", header: "Email", sortable: true },
            {
              key: "role",
              header: "Role",
              render: (row) => (
                <select
                  aria-label={`Role of ${row.name}`}
                  value={row.member.roleKey}
                  style={CONTROL}
                  onChange={(event) => void changeRole(row.member, event.target.value)}
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ),
            },
            {
              key: "twoFactor",
              header: "Two-factor",
              render: (row) => (row.member.twoFactor ? "On" : "Off"),
            },
            {
              key: "joined",
              header: "Joined",
              sortValue: (row) => row.member.joinedAt,
              sortable: true,
              render: (row) => when(row.member.joinedAt),
            },
            {
              key: "actions",
              header: "Actions",
              render: (row) =>
                row.member.userId === you ? null : (
                  <Button
                    size="sm"
                    color="danger"
                    aria-label={`Remove ${row.name}`}
                    onPress={() => {
                      setProblem(null);
                      setRemoving(row.member);
                    }}
                  >
                    Remove
                  </Button>
                ),
            },
          ]}
        />
      </section>

      <section aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite someone</h2>
        <p>
          You get a link to send to the person
          {emailWorks ? ", and the site can email it to them" : ""}. They open it and choose their
          own password, so you never know it. The link works once.
        </p>
        {emailWorks ? null : (
          <p>
            The site cannot send email yet, so you send the link yourself.{" "}
            <a href="/admin/settings/email">Set up email</a>
          </p>
        )}
        <form onSubmit={(event) => void invite(event)} aria-label="Invite someone">
          {inviteProblem ? (
            <Alert color="danger" title="Not invited" description={inviteProblem} />
          ) : null}
          <TextField name="name" label="Name" required value={name} onChange={setName} />
          <TextField
            name="email"
            label="Email"
            type="email"
            required
            value={email}
            onChange={setEmail}
          />
          <div style={ROW}>
            <label htmlFor="invite-role">Role</label>
            <select
              id="invite-role"
              value={roleKey}
              style={CONTROL}
              onChange={(event) => setRoleKey(event.target.value)}
            >
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <label htmlFor="invite-days">Link works for</label>
            <select
              id="invite-days"
              value={days}
              style={CONTROL}
              onChange={(event) => setDays(event.target.value)}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 day" : `${d} days`}
                </option>
              ))}
            </select>
          </div>
          {emailWorks ? (
            <div style={ROW}>
              <label>
                <input
                  type="checkbox"
                  checked={byEmail}
                  onChange={(event) => setByEmail(event.target.checked)}
                />{" "}
                Send the invitation by email
              </label>
            </div>
          ) : null}
          <Button type="submit" color="primary" isDisabled={busy}>
            {emailWorks && byEmail ? "Invite and send the email" : "Make an invitation link"}
          </Button>
        </form>
        {made ? (
          <div role="group" aria-label="The invitation link">
            <p>
              The invitation for <strong>{made.invitation.name}</strong> as{" "}
              <strong>{label(made.invitation.roleKey)}</strong> is ready.{" "}
              {made.emailed
                ? `It is on its way to ${made.invitation.email} by email. You can also send them this link yourself; it is shown only now.`
                : "Send them this link; it is shown only now."}
            </p>
            <div style={ROW}>
              <label htmlFor="invite-link">Invitation link</label>
              <input
                id="invite-link"
                type="text"
                readOnly
                value={made.link}
                style={{ ...CONTROL, width: "100%", maxWidth: "40rem" }}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button onPress={() => void copy(made.link)}>Copy</Button>
            </div>
            <p role="status">{copied}</p>
            <p>It stops working on {when(made.invitation.expiresAt)}.</p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="waiting-heading">
        <h2 id="waiting-heading">Invitations waiting</h2>
        {inviteRows.length === 0 ? (
          <p>No invitations are waiting.</p>
        ) : (
          <ListTable
            label="Invitations waiting"
            rows={inviteRows}
            getRowKey={(row) => row.id}
            columns={[
              { key: "name", header: "Name", sortable: true },
              { key: "email", header: "Email", sortable: true },
              { key: "role", header: "Role", render: (row) => label(row.invitation.roleKey) },
              {
                key: "expires",
                header: "Stops working",
                sortValue: (row) => row.invitation.expiresAt,
                sortable: true,
                render: (row) => when(row.invitation.expiresAt),
              },
              {
                key: "actions",
                header: "Actions",
                render: (row) => (
                  <Button
                    size="sm"
                    color="danger"
                    aria-label={`Cancel the invitation for ${row.name}`}
                    onPress={() => setCancelling(row.invitation)}
                  >
                    Cancel
                  </Button>
                ),
              },
            ]}
          />
        )}
      </section>

      <Modal
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        role="alertdialog"
        title="Remove this person?"
        actions={
          <>
            <Button onPress={() => setRemoving(null)}>Keep</Button>
            <Button color="danger" onPress={() => void remove()}>
              Remove
            </Button>
          </>
        }
      >
        <p>
          {removing?.name} can no longer sign in to the admin of this site. Their account and
          everything they wrote stay.
        </p>
      </Modal>
      <Modal
        isOpen={cancelling !== null}
        onClose={() => setCancelling(null)}
        role="alertdialog"
        title="Cancel this invitation?"
        actions={
          <>
            <Button onPress={() => setCancelling(null)}>Keep</Button>
            <Button color="danger" onPress={() => void cancel()}>
              Cancel the invitation
            </Button>
          </>
        }
      >
        <p>The link for {cancelling?.name} stops working at once.</p>
      </Modal>
    </>
  );
}
