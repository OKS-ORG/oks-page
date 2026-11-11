"use client";
// The edit screen: title, address, status and the editor. Saving sends everything and learns the new revision.
import { EntryEditor } from "@oks-page/admin";
import { Alert, Button, Modal, RadioGroupField, TextField } from "oks-ui";
import { useRef, useState } from "react";
import type { Block } from "oks-ui";
import { EntryRevisions } from "./entry-revisions";
import { uploadForEditor } from "./media-client";
import { MediaPicker } from "./media-picker";

export interface EntryEditScreenProps {
  id: string;
  title: string;
  slugPart: string;
  prefix: string;
  status: string;
  /** When a scheduled entry goes live (ISO time), or null. */
  scheduledAt: string | null;
  revision: number;
  blocks: Block[];
  canPublish: boolean;
  canTrash: boolean;
  /** Where the list this entry belongs to is ("/admin/pages"). */
  listHref: string;
}

interface SaveReply {
  revision?: number;
  repairs?: string[];
  slug?: string;
  error?: { message: string };
}

/** An ISO time as the value of a datetime-local box (the viewer's own clock), and back. */
const pad = (n: number) => String(n).padStart(2, "0");
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string | null {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

/** The "Insert image from the library" button and its window. */
function InsertFromLibrary({ insertImage }: { insertImage: (src: string, alt: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Insert image from the library</Button>
      <MediaPicker
        isOpen={open}
        onClose={() => setOpen(false)}
        onPick={(item) => {
          insertImage(item.url, item.alt);
          setOpen(false);
        }}
      />
    </>
  );
}

export function EntryEditScreen(props: EntryEditScreenProps) {
  const [title, setTitle] = useState(props.title);
  const [slugPart, setSlugPart] = useState(props.slugPart);
  const [status, setStatus] = useState(
    props.status === "published" || props.status === "scheduled" ? props.status : "draft",
  );
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(props.scheduledAt));
  const revision = useRef(props.revision);
  const [revisionNo, setRevisionNo] = useState(props.revision);
  const [trashing, setTrashing] = useState(false);

  async function moveToTrash() {
    setProblem(null);
    try {
      const response = await fetch(`/api/admin/entries/${props.id}`, { method: "DELETE" });
      if (response.ok) {
        window.location.assign(props.listHref);
        return;
      }
      const body = (await response.json()) as { error?: { message: string } };
      setProblem(body.error?.message ?? "It could not be moved to the trash.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setTrashing(false);
  }
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <TextField name="title" label="Title" required value={title} onChange={setTitle} />
      <TextField
        name="slug"
        label="Address"
        description={`The address of this page: /${props.prefix}${slugPart}`}
        required
        value={slugPart}
        onChange={setSlugPart}
      />
      {props.canPublish ? (
        <RadioGroupField
          name="status"
          label="Status"
          options={[
            { label: "Draft (only you see it)", value: "draft" },
            { label: "Scheduled (goes live at the time you choose)", value: "scheduled" },
            { label: "Published (everyone sees it)", value: "published" },
          ]}
          value={status}
          onChange={(value: string) => setStatus(value)}
        />
      ) : (
        <p>Status: draft. An editor publishes it.</p>
      )}
      {props.canPublish && status === "scheduled" ? (
        <div>
          <label htmlFor="scheduled-at">Publish at</label>
          <input
            id="scheduled-at"
            name="scheduledAt"
            type="datetime-local"
            required
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
            aria-describedby="scheduled-at-help"
          />
          <p id="scheduled-at-help">
            The time on your own clock. The page goes live then, with your permission.
          </p>
        </div>
      ) : null}
      <EntryEditor
        label="Content"
        initialBlocks={props.blocks}
        onImageUpload={uploadForEditor}
        onFileUpload={uploadForEditor}
        onVideoUpload={uploadForEditor}
        toolbar={({ insertImage }) => <InsertFromLibrary insertImage={insertImage} />}
        onSave={async (blocks) => {
          setProblem(null);
          const response = await fetch(`/api/admin/entries/${props.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title,
              slugPart,
              status,
              scheduledAt: status === "scheduled" ? fromLocalInput(scheduledAt) : null,
              blocks,
              revision: revision.current,
            }),
          });
          const body = (await response.json()) as SaveReply;
          if (!response.ok) {
            const message = body.error?.message ?? "Saving did not work.";
            setProblem(message);
            throw new Error(message);
          }
          revision.current = body.revision ?? revision.current;
          setRevisionNo(revision.current);
          return { repairs: body.repairs ?? [] };
        }}
      />
      <EntryRevisions id={props.id} revision={revisionNo} />
      {props.canTrash ? (
        <p>
          <Button color="danger" onPress={() => setTrashing(true)}>
            Move to trash
          </Button>
        </p>
      ) : null}
      <Modal
        isOpen={trashing}
        onClose={() => setTrashing(false)}
        role="alertdialog"
        title="Move to the trash?"
        actions={
          <>
            <Button onPress={() => setTrashing(false)}>Cancel</Button>
            <Button color="danger" onPress={() => void moveToTrash()}>
              Move to trash
            </Button>
          </>
        }
      >
        <p>
          “{title}” leaves the site at once. It stays in the trash for 30 days, and you can restore
          it from there.
        </p>
      </Modal>
    </>
  );
}
