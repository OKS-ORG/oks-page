"use client";
// Comments: the on / off switch (for people who manage the settings) and the list to approve, mark as spam, or trash. Drawn as
// the design shows: a line under the title, tabs with their counts, and a card with one block for each comment.
import type { CommentStatus, ListedComment } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState } from "react";

const TABS: { status: CommentStatus; label: string }[] = [
  { status: "pending", label: "Waiting" },
  { status: "approved", label: "Approved" },
  { status: "spam", label: "Spam" },
  { status: "trash", label: "Trash" },
];

const CHIPS: Record<CommentStatus, { word: string; kind: string }> = {
  pending: { word: "Waiting", kind: "scheduled" },
  approved: { word: "Approved", kind: "published" },
  spam: { word: "Spam", kind: "draft" },
  trash: { word: "Trash", kind: "scheduled" },
};

interface Listing {
  comments: ListedComment[];
  counts: Record<CommentStatus, number>;
}

export function CommentsScreen({
  initialEnabled,
  initial,
  canSwitch,
}: {
  initialEnabled: boolean;
  initial: Listing;
  canSwitch: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<CommentStatus>("pending");
  const [listing, setListing] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function show(next: CommentStatus) {
    const response = await fetch(`/api/admin/comments?status=${next}`);
    const body = (await response.json().catch(() => null)) as
      (Listing & { error?: { message?: string } }) | null;
    if (!response.ok || !body?.comments) {
      setProblem(body?.error?.message ?? "The comments could not be loaded.");
      return;
    }
    setStatus(next);
    setListing({ comments: body.comments, counts: body.counts });
  }

  async function act(id: string, action: string, said: string) {
    setProblem(null);
    const response = await fetch("/api/admin/comments", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setProblem(body?.error?.message ?? "That did not work.");
      return;
    }
    setNote(said);
    await show(status);
  }

  async function switchTo(value: boolean) {
    setProblem(null);
    const response = await fetch("/api/admin/comments", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: value }),
    });
    const body = (await response.json().catch(() => null)) as {
      enabled?: boolean;
      error?: { message?: string };
    } | null;
    if (!response.ok || body?.enabled === undefined) {
      setProblem(body?.error?.message ?? "The setting could not be saved.");
      return;
    }
    setEnabled(body.enabled);
    setNote(body.enabled ? "Comments are on for posts." : "Comments are off. Posts show none.");
  }

  return (
    <section aria-labelledby="comments-admin-heading" className="oks-bare">
      <h2 id="comments-admin-heading" className="oks-sr-only">
        Comments
      </h2>
      <div className="oks-list-head">
        <p className="oks-list-summary">Comments that wait for you appear here first.</p>
      </div>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <div className="oks-switch-card">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canSwitch}
            onChange={(event) => void switchTo(event.target.checked)}
          />{" "}
          Let visitors comment on posts
        </label>
        <small>
          Every comment waits here until you approve it. Visitors give a name and a text; no email
          is asked for and nothing else about them is stored.
        </small>
      </div>
      <p className="oks-status-line" role="status">
        {note}
      </p>
      <div className="oks-list-tabs" role="group" aria-label="Show comments that are">
        {TABS.map((t) => (
          <button
            key={t.status}
            type="button"
            className="oks-list-tab"
            onClick={() => void show(t.status)}
            aria-pressed={status === t.status}
          >
            {t.label} <span>{listing.counts[t.status]}</span>
          </button>
        ))}
      </div>
      {listing.comments.length === 0 ? (
        <p>No comments here.</p>
      ) : (
        <ul aria-label="Comments" className="oks-comments">
          {listing.comments.map((c) => (
            <li key={c.id} className="oks-comment">
              <span className="oks-person-mark" aria-hidden="true">
                {(c.name || "?").charAt(0).toUpperCase()}
              </span>
              <div className="oks-comment-body">
                <p className="oks-comment-head">
                  <strong>{c.name}</strong>
                  <span className="oks-list-path">{c.createdAt.slice(0, 10)}</span>
                  <span className="oks-chip" data-status={CHIPS[c.status].kind}>
                    {CHIPS[c.status].word}
                  </span>
                </p>
                <p className="oks-list-path">
                  on <a href={`/admin/posts/${c.entryId}`}>{c.entryTitle}</a>
                </p>
                <p className="oks-comment-text">{c.content}</p>
                <div className="oks-comment-actions">
                  {c.status !== "approved" && c.status !== "trash" ? (
                    <Button
                      color="primary"
                      onPress={() =>
                        void act(c.id, "approve", "The comment is approved and shows on the post.")
                      }
                    >
                      Approve
                    </Button>
                  ) : null}
                  {c.status === "pending" ? (
                    <Button onPress={() => void act(c.id, "spam", "Marked as spam.")}>Spam</Button>
                  ) : null}
                  {c.status === "spam" || c.status === "trash" ? (
                    <Button onPress={() => void act(c.id, "restore", "Back in the waiting list.")}>
                      Not spam, restore
                    </Button>
                  ) : null}
                  {c.status !== "trash" ? (
                    <Button onPress={() => void act(c.id, "trash", "Moved to the trash.")}>
                      Trash
                    </Button>
                  ) : (
                    <Button
                      color="danger"
                      onPress={() => void act(c.id, "delete", "Deleted for good.")}
                    >
                      Delete for good
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
