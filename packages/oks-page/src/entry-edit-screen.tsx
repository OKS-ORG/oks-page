"use client";
// The edit screen: title, address, status and the editor. Saving sends everything and learns the new revision.
import { EntryEditor } from "@oks-page/admin";
import { Alert, Button, RadioGroupField, TextField } from "oks-ui";
import { useRef, useState } from "react";
import type { Block } from "oks-ui";
import { uploadForEditor } from "./media-client";
import { MediaPicker } from "./media-picker";

export interface EntryEditScreenProps {
  id: string;
  title: string;
  slugPart: string;
  prefix: string;
  status: string;
  revision: number;
  blocks: Block[];
  canPublish: boolean;
}

interface SaveReply {
  revision?: number;
  repairs?: string[];
  slug?: string;
  error?: { message: string };
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
  const [status, setStatus] = useState(props.status === "published" ? "published" : "draft");
  const revision = useRef(props.revision);
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
            { label: "Published (everyone sees it)", value: "published" },
          ]}
          value={status}
          onChange={(value: string) => setStatus(value)}
        />
      ) : (
        <p>Status: draft. An editor publishes it.</p>
      )}
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
            body: JSON.stringify({ title, slugPart, status, blocks, revision: revision.current }),
          });
          const body = (await response.json()) as SaveReply;
          if (!response.ok) {
            const message = body.error?.message ?? "Saving did not work.";
            setProblem(message);
            throw new Error(message);
          }
          revision.current = body.revision ?? revision.current;
          return { repairs: body.repairs ?? [] };
        }}
      />
    </>
  );
}
