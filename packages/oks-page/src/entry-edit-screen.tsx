"use client";
// The edit screen: title, address, status and the editor. Saving sends everything and learns the new revision.
import { EntryEditor } from "@oks-page/admin";
import { utcToZonedLocal, zonedLocalToUtc } from "@oks-page/core/timezone";
import { Alert, Button, Modal, RadioGroupField, TextField } from "oks-ui";
import { useEffect, useRef, useState } from "react";
import type { Block } from "oks-ui";
import {
  AutosaveStatus,
  EditingNotice,
  UnsavedCopyBanner,
  useAutosave,
  useEditingNotice,
  useUnsavedCopy,
} from "./entry-editing";
import { EntryRevisions } from "./entry-revisions";
import { EntryPreview } from "./entry-preview";
import { EntryLayoutPanel } from "./entry-layout-panel";
import { EntrySeoPanel } from "./entry-seo-panel";
import { EntryTermsPanel } from "./entry-terms-panel";
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
  /** Posts have categories and tags; pages do not. */
  showTerms?: boolean;
  /** Where the list this entry belongs to is ("/admin/pages"). */
  listHref: string;
  /** The site's time zone, or null when it is automatic (each person's own browser). */
  timeZone?: string | null;
}

interface SaveReply {
  revision?: number;
  repairs?: string[];
  slug?: string;
  error?: { message: string };
}

/**
 * An ISO time as the value of a datetime-local box, and back. The box is in the site's time zone; a site that has not
 * chosen one ("automatic") uses this browser's own zone.
 */
const zoneOf = (timeZone: string | null): string =>
  timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
function toLocalInput(iso: string | null, timeZone: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : utcToZonedLocal(ms, zoneOf(timeZone));
}
function fromLocalInput(value: string, timeZone: string | null): string | null {
  const ms = zonedLocalToUtc(value, zoneOf(timeZone));
  return ms === null ? null : new Date(ms).toISOString();
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
  const [scheduledAt, setScheduledAt] = useState(
    toLocalInput(props.scheduledAt, props.timeZone ?? null),
  );
  const revision = useRef(props.revision);
  const [revisionNo, setRevisionNo] = useState(props.revision);
  const [trashing, setTrashing] = useState(false);
  // Autosave: a counter that goes up with every change, and the latest content to send.
  const [changes, setChanges] = useState(0);
  const blocksNow = useRef(props.blocks);
  const typed = useRef({ title, slugPart });
  typed.current = { title, slugPart };
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setChanges((n) => n + 1);
  }, [title, slugPart]);
  const keptAt = useAutosave(
    props.id,
    () => ({ ...typed.current, blocks: blocksNow.current, revision: revision.current }),
    changes,
  );
  const [unsaved, forgetUnsaved] = useUnsavedCopy(props.id);
  const otherEditor = useEditingNotice(props.id);

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
      <EditingNotice name={otherEditor} />
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
            {props.timeZone
              ? `The time in ${props.timeZone.replace(/_/g, " ")}.`
              : "The time on your own clock."}{" "}
            The page goes live then, with your permission.
          </p>
        </div>
      ) : null}
      <EntryEditor
        label="Content"
        initialBlocks={props.blocks}
        onImageUpload={uploadForEditor}
        onFileUpload={uploadForEditor}
        onVideoUpload={uploadForEditor}
        onBlocksChange={(next) => {
          blocksNow.current = next;
          setChanges((n) => n + 1);
        }}
        toolbar={({ insertImage, replaceBlocks }) => (
          <>
            <InsertFromLibrary insertImage={insertImage} />
            <UnsavedCopyBanner
              copy={unsaved}
              timeZone={props.timeZone ?? null}
              onBringBack={(copy) => {
                setTitle(copy.title);
                replaceBlocks(copy.blocks);
                forgetUnsaved();
              }}
              onThrowAway={() => {
                forgetUnsaved();
                void fetch(`/api/admin/entries/${props.id}/autosave`, { method: "DELETE" });
              }}
            />
          </>
        )}
        onSave={async (blocks) => {
          setProblem(null);
          const response = await fetch(`/api/admin/entries/${props.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title,
              slugPart,
              status,
              scheduledAt:
                status === "scheduled" ? fromLocalInput(scheduledAt, props.timeZone ?? null) : null,
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
      {props.showTerms ? <EntryTermsPanel id={props.id} /> : null}
      <EntryLayoutPanel id={props.id} />
      <EntrySeoPanel id={props.id} />
      <EntryPreview id={props.id} />
      <AutosaveStatus savedAt={keptAt} timeZone={props.timeZone ?? null} />
      <EntryRevisions id={props.id} revision={revisionNo} timeZone={props.timeZone ?? null} />
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
