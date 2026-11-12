"use client";
// The media library screen: a grid with search, type filters and upload (a button or dropping files), and a panel for
// the file you pick.
import { Alert, MediaLibrary, type MediaKind } from "oks-ui";
import { useState } from "react";
import { MediaDetails } from "./media-details";
import { toLibraryItem, type MediaItem } from "./media-client";
import { useLibrary } from "./use-library";

export const ACCEPT =
  "image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml,application/pdf,video/mp4,audio/mpeg";
const KINDS: MediaKind[] = ["image", "video", "audio", "document"];

export interface MediaLibraryScreenProps {
  initial: { items: MediaItem[]; total: number };
  canUpload: boolean;
  canDelete: boolean;
  /** Shows the link to the media settings (the biggest file and picture, photo details). */
  canManageSettings?: boolean;
}

export function MediaLibraryScreen({
  initial,
  canUpload,
  canDelete,
  canManageSettings,
}: MediaLibraryScreenProps) {
  const lib = useLibrary(initial);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="oks-media">
      <div className="oks-media-main">
        {canManageSettings ? (
          <p>
            <a href="/admin/settings/media">Media settings</a>
          </p>
        ) : null}
        {lib.problem ? (
          <Alert color="danger" title="The library could not be loaded" description={lib.problem} />
        ) : null}
        <ul className="oks-media-uploads" aria-label="Uploads">
          {lib.uploads.map((u) => (
            <li key={u.key}>
              {u.state === "uploading" ? (
                <span role="status">
                  Uploading {u.name}… {Math.round(u.progress * 100)}%
                </span>
              ) : null}
              {u.state === "done" ? <span role="status">Uploaded {u.name}.</span> : null}
              {u.state === "failed" ? (
                <span role="alert">
                  {u.name} was not uploaded: {u.message}
                </span>
              ) : null}{" "}
              {u.state !== "uploading" ? (
                <button type="button" onClick={() => lib.dismissUpload(u.key)}>
                  Dismiss
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <MediaLibrary
          aria-label="Media library"
          items={lib.items.map(toLibraryItem)}
          filtering="none"
          search={lib.search}
          onSearchChange={lib.setSearch}
          kinds={KINDS}
          filter={lib.kind}
          onFilterChange={lib.setKind}
          hasMore={lib.hasMore}
          onLoadMore={() => void lib.loadMore()}
          isLoading={lib.loading}
          selectedKeys={selected ? [selected] : []}
          onSelectionChange={(keys) => setSelected(keys[0] ?? null)}
          {...(canUpload
            ? {
                onUpload: (files: File[]) =>
                  void lib.upload(files).then((ids) => ids[0] && setSelected(ids[0])),
                accept: ACCEPT,
              }
            : {})}
          emptyContent={
            <p>
              {canUpload ? "No files yet. Choose Upload, or drop files here." : "No files yet."}
            </p>
          }
        />
      </div>
      <div className="oks-media-side">
        {selected ? (
          <MediaDetails
            key={selected}
            id={selected}
            canDelete={canDelete}
            onChanged={(deleted) => {
              if (deleted) setSelected(null);
              void lib.reload();
            }}
          />
        ) : (
          <p>Pick a file to see its details.</p>
        )}
      </div>
    </div>
  );
}
