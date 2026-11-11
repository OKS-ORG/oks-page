"use client";
// A window with the library to pick an image from, used by the editor's "Insert image from library".
import { Alert, Button, MediaLibrary, Modal } from "oks-ui";
import { useState } from "react";
import { loadFile, toLibraryItem, type MediaItem } from "./media-client";
import { ACCEPT } from "./media-library";
import { useLibrary } from "./use-library";

export interface MediaPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onPick: (item: MediaItem) => void;
}

function Picker({ onClose, onPick }: Omit<MediaPickerProps, "isOpen">) {
  const lib = useLibrary();
  const [selected, setSelected] = useState<string | null>(null);
  const images = lib.items.filter((i) => i.mimeType.startsWith("image/"));
  const choose = (id: string | null) => {
    const item = images.find((i) => i.id === id);
    if (item) onPick(item);
  };
  return (
    <>
      {lib.problem ? (
        <Alert color="danger" title="Could not load" description={lib.problem} />
      ) : null}
      <ul aria-label="Uploads">
        {lib.uploads.map((u) => (
          <li key={u.key}>
            {u.state === "failed" ? (
              <span role="alert">
                {u.name} was not uploaded: {u.message}
              </span>
            ) : (
              <span role="status">
                {u.state === "uploading" ? `Uploading ${u.name}…` : `Uploaded ${u.name}.`}
              </span>
            )}
          </li>
        ))}
      </ul>
      <MediaLibrary
        aria-label="Pick an image"
        items={images.map(toLibraryItem)}
        filtering="none"
        search={lib.search}
        onSearchChange={lib.setSearch}
        kinds={[]}
        hasMore={lib.hasMore}
        onLoadMore={() => void lib.loadMore()}
        isLoading={lib.loading}
        selectedKeys={selected ? [selected] : []}
        onSelectionChange={(keys) => setSelected(keys[0] ?? null)}
        onAction={(item) => choose(item.id)}
        onUpload={(files: File[]) =>
          // The list is not up to date yet, so the stored file is fetched and inserted.
          void lib.upload(files).then(async (ids) => {
            if (ids[0]) onPick((await loadFile(ids[0])).item);
          })
        }
        accept={ACCEPT.split(",")
          .filter((t) => t.startsWith("image/") && t !== "image/svg+xml")
          .join(",")}
        emptyContent={<p>No images yet. Choose Upload to add one.</p>}
      />
      <p>
        <Button color="primary" isDisabled={!selected} onPress={() => choose(selected)}>
          Insert image
        </Button>{" "}
        <Button onPress={onClose}>Cancel</Button>
      </p>
    </>
  );
}

export function MediaPicker({ isOpen, onClose, onPick }: MediaPickerProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Insert an image from the library" size="lg">
      {isOpen ? <Picker onClose={onClose} onPick={onPick} /> : null}
    </Modal>
  );
}
