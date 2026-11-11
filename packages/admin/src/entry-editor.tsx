// The entry editor (spec 03, sections 4 and 8): oks-ui's TextEditor with a Save button. The blocks are checked and
// repaired on the server before they are stored (ADR 0019): this component only sends them and reports what was fixed.
import { Button, TextEditor, type Block, type TextEditorHandle, type UploadHandler } from "oks-ui";
import { useRef, useState, type ReactNode } from "react";

export interface SaveResult {
  /** One entry per repair the block checks made. */
  repairs: string[];
}

export interface EntryEditorProps {
  initialBlocks: Block[];
  /** Sends the blocks to the server, where the block checks run. */
  onSave: (blocks: Block[]) => Promise<SaveResult>;
  /** Tells the tab strip whether there are unsaved changes (the dot, D111). */
  onDirtyChange?: (dirty: boolean) => void;
  /** The block types this content type may hold (EC-42 is enforced on the server as well). */
  allowedBlocks?: Block["type"][];
  label?: string;
  /** Store a file the writer adds to an image, file or video block and give back its address. */
  onImageUpload?: UploadHandler;
  onFileUpload?: UploadHandler;
  onVideoUpload?: UploadHandler;
  /** Buttons above the editor, with the tools they may use (for example "Insert image from the library"). */
  toolbar?: (tools: EditorTools) => ReactNode;
}

export interface EditorTools {
  /** Adds an image block at the end of the content. */
  insertImage: (src: string, alt: string) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; repairs: number }
  | { kind: "error"; message: string };

export function EntryEditor({
  initialBlocks,
  onSave,
  onDirtyChange,
  allowedBlocks,
  label = "Content",
  onImageUpload,
  onFileUpload,
  onVideoUpload,
  toolbar,
}: EntryEditorProps) {
  const editor = useRef<TextEditorHandle>(null);
  const [blocks, setBlocks] = useState(initialBlocks);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const dirty = useRef(false);
  const setDirty = (next: boolean) => {
    if (dirty.current === next) return;
    dirty.current = next;
    onDirtyChange?.(next);
  };
  const save = async () => {
    setStatus({ kind: "saving" });
    try {
      const result = await onSave(blocks);
      setDirty(false);
      setStatus({ kind: "saved", repairs: result.repairs.length });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "" });
    }
  };
  const tools: EditorTools = {
    insertImage: (src, alt) => {
      const current = editor.current?.getBlocks() ?? blocks;
      const image = {
        id: crypto.randomUUID(),
        type: "image",
        props: { src, alt },
        content: [],
        children: [],
      } as unknown as Block;
      editor.current?.setBlocks([...current, image]);
    },
  };
  return (
    <div className="oks-entry-editor">
      {toolbar ? <div className="oks-entry-toolbar">{toolbar(tools)}</div> : null}
      <TextEditor
        ref={editor}
        label={label}
        {...(onImageUpload ? { onImageUpload } : {})}
        {...(onFileUpload ? { onFileUpload } : {})}
        {...(onVideoUpload ? { onVideoUpload } : {})}
        value={blocks}
        {...(allowedBlocks ? { allowedBlocks } : {})}
        onChange={(next) => {
          setBlocks(next);
          setDirty(true);
          setStatus({ kind: "idle" });
        }}
      />
      <div className="oks-entry-actions">
        <Button color="primary" isDisabled={status.kind === "saving"} onPress={() => void save()}>
          Save
        </Button>
        <span role="status">
          {status.kind === "saving" ? "Saving…" : null}
          {status.kind === "saved"
            ? status.repairs === 0
              ? "Saved."
              : `Saved. We fixed ${status.repairs} ${status.repairs === 1 ? "thing" : "things"} that were not safe or not valid.`
            : null}
        </span>
        {status.kind === "error" ? (
          <span role="alert">
            Could not save{status.message ? `: ${status.message}` : ""}. Your changes are still
            here: try again.
          </span>
        ) : null}
      </div>
    </div>
  );
}
