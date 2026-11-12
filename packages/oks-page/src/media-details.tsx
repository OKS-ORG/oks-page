"use client";
// The panel next to the library grid: a preview, the description fields, where the file is used, and delete.
import { Alert, Button, Modal, TextField } from "oks-ui";
import { useEffect, useState } from "react";
import {
  deleteFile,
  editAddress,
  loadFile,
  replaceFile,
  saveFile,
  type MediaItem,
  type UsedBy,
} from "./media-client";

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export interface MediaDetailsProps {
  id: string;
  canDelete: boolean;
  /** Called after a save or a delete so the grid can refresh. */
  onChanged: (deleted: boolean) => void;
}

export function MediaDetails({ id, canDelete, onChanged }: MediaDetailsProps) {
  const [item, setItem] = useState<MediaItem | null>(null);
  const [usedIn, setUsedIn] = useState<UsedBy[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [caption, setCaption] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [blockedBy, setBlockedBy] = useState<UsedBy[] | null>(null);
  // Goes up after a replacement: the file is loaded again, but what was typed stays.
  const [version, setVersion] = useState(0);

  // Load the file when another one is picked, and look again while its sizes are being made.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fill = (fresh: MediaItem) => {
      setAlt(fresh.alt);
      setCaption(fresh.caption);
      setTitle(fresh.title);
      setDescription(fresh.description);
    };
    const run = async (first: boolean) => {
      try {
        const got = await loadFile(id);
        if (cancelled) return;
        setItem(got.item);
        setUsedIn(got.usedIn);
        setCanEdit(got.canEdit);
        if (first) fill(got.item);
        if (got.item.status === "processing") timer = setTimeout(() => void run(false), 1500);
      } catch (error) {
        if (!cancelled) setProblem((error as Error).message);
      }
    };
    if (version === 0) {
      setItem(null);
      setProblem(null);
      setNote("");
      setBlockedBy(null);
      setConfirming(false);
    }
    void run(version === 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, version]);

  // Another file was picked: start from the beginning.
  useEffect(() => setVersion(0), [id]);

  if (problem)
    return <Alert color="danger" title="Could not open the file" description={problem} />;
  if (!item) return <p role="status">Loading…</p>;

  const isImage = item.mimeType.startsWith("image/");

  async function save() {
    setNote("Saving…");
    try {
      await saveFile(id, { alt, caption, title, description });
      setNote("Saved.");
      onChanged(false);
    } catch (error) {
      setNote(`Could not save: ${(error as Error).message}`);
    }
  }

  async function replace(file: File | undefined) {
    if (!file) return;
    setNote("Replacing the file…");
    try {
      await replaceFile(id, file);
      setNote("The file was replaced. Pages that use it show the new one.");
      setVersion((v) => v + 1);
      onChanged(false);
    } catch (error) {
      setNote(`Could not replace the file: ${(error as Error).message}`);
    }
  }

  async function remove() {
    setConfirming(false);
    const result = await deleteFile(id);
    if (result.ok) {
      onChanged(true);
      return;
    }
    setBlockedBy(result.usedIn);
    setNote(result.message);
  }

  return (
    <section className="oks-media-details" aria-label="File details">
      <h2>{item.fileName}</h2>
      {isImage ? (
        <img
          className="oks-media-preview"
          src={version > 0 ? `${item.url}?v=${version}` : item.url}
          alt={item.alt || `Preview of ${item.fileName}`}
          {...(item.width ? { width: item.width } : {})}
        />
      ) : null}
      <p>
        {item.mimeType} · {size(item.sizeBytes)}
        {item.width && item.height ? ` · ${item.width} × ${item.height}` : ""}
      </p>
      {item.status === "processing" ? <p role="status">Making the smaller sizes…</p> : null}
      {item.status === "failed" ? (
        <Alert
          color="warning"
          title="The smaller sizes could not be made"
          description="The original file still works. Upload it again if the problem stays."
        />
      ) : null}
      <p>
        <a href={item.url} target="_blank" rel="noreferrer">
          Open the file
        </a>
      </p>
      {isImage ? (
        <TextField
          name="alt"
          label="Alt text"
          description="Describes the picture for people who cannot see it. Leave it empty only if the picture is decoration."
          value={alt}
          onChange={setAlt}
          disabled={!canEdit}
        />
      ) : null}
      <TextField name="title" label="Title" value={title} onChange={setTitle} disabled={!canEdit} />
      <TextField
        name="caption"
        label="Caption"
        value={caption}
        onChange={setCaption}
        disabled={!canEdit}
      />
      <TextField
        name="description"
        label="Description"
        value={description}
        onChange={setDescription}
        disabled={!canEdit}
      />
      {canEdit ? (
        <p>
          <Button color="primary" onPress={() => void save()}>
            Save details
          </Button>{" "}
          {canDelete ? (
            <Button color="danger" onPress={() => setConfirming(true)}>
              Delete
            </Button>
          ) : null}
        </p>
      ) : null}
      {canEdit ? (
        <p>
          <label>
            Replace file{" "}
            <input
              type="file"
              name="replacement"
              accept={item.mimeType}
              onChange={(event) => {
                const input = event.currentTarget;
                void replace(input.files?.[0]).finally(() => {
                  input.value = "";
                });
              }}
            />
          </label>
          <br />
          <small>
            The address and the pages that use it stay the same. It must be the same kind of file.
          </small>
        </p>
      ) : null}
      <p role="status">{note}</p>
      {blockedBy && blockedBy.length > 0 ? (
        <Alert
          color="warning"
          title="This file is in use"
          description="Take it out of these pages first, then delete it."
        />
      ) : null}
      <h3>Used in</h3>
      {(blockedBy ?? usedIn).length === 0 ? (
        <p>Not used on any page yet.</p>
      ) : (
        <ul>
          {(blockedBy ?? usedIn).map((use) => (
            <li key={use.id}>
              <a href={editAddress(use)}>{use.title}</a> ({use.type})
            </li>
          ))}
        </ul>
      )}
      <Modal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        title="Delete this file?"
        actions={
          <>
            <Button onPress={() => setConfirming(false)}>Cancel</Button>
            <Button color="danger" onPress={() => void remove()}>
              Delete file
            </Button>
          </>
        }
      >
        <p>{item.fileName} and its smaller sizes will be removed. This cannot be undone.</p>
      </Modal>
    </section>
  );
}
