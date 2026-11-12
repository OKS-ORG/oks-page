"use client";
// What the browser side of the library uses: uploading with progress, loading a page of the list, and the shape of a
// file as the screens show it. The server rules (who may, what is allowed) live in the core; this only calls the API.
import type { MediaItem } from "@oks-page/core";
import type { MediaItem as LibraryItem, MediaKind } from "oks-ui";

export type { MediaItem };

/** The reason an API call failed, in plain words. */
const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

/** Uploads one file to the library and says how far it is. Resolves with the new file. */
export function uploadFile(
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<{ id: string; status: string; url: string; fileName: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/media");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: the fallback message is used.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as { id: string; status: string; url: string; fileName: string });
      } else {
        reject(new Error(failure(body, "The upload did not work. Try again.")));
      }
    };
    xhr.onerror = () =>
      reject(new Error("The site could not be reached. Check your connection and try again."));
    options.signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    });
    const form = new FormData();
    form.set("file", file);
    xhr.send(form);
  });
}

/** For the editor's image, file and video blocks: uploads the file and returns the address to put in the block. */
export const uploadForEditor = (
  file: File,
  { onProgress, signal }: { onProgress: (fraction: number) => void; signal: AbortSignal },
): Promise<string> => uploadFile(file, { onProgress, signal }).then((made) => made.url);

export type LibraryKind = "all" | MediaKind;

/** The library's type filter names a document; the API calls it a pdf. */
const API_KIND: Record<MediaKind, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "pdf",
};

export async function loadLibrary(options: {
  search?: string;
  kind?: LibraryKind;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ items: MediaItem[]; total: number }> {
  const q = new URLSearchParams();
  if (options.search?.trim()) q.set("search", options.search.trim());
  if (options.kind && options.kind !== "all") q.set("kind", API_KIND[options.kind]);
  if (options.offset) q.set("offset", String(options.offset));
  q.set("limit", String(options.limit ?? 40));
  const response = await fetch(`/api/admin/media?${q}`, { signal: options.signal ?? null });
  const body = (await response.json()) as { items?: MediaItem[]; total?: number };
  if (!response.ok) throw new Error(failure(body, "The library could not be loaded."));
  return { items: body.items ?? [], total: body.total ?? 0 };
}

export interface UsedBy {
  id: string;
  title: string;
  type: string;
}

export async function loadFile(
  id: string,
): Promise<{ item: MediaItem; usedIn: UsedBy[]; canEdit: boolean }> {
  const response = await fetch(`/api/admin/media/${id}`);
  const body = (await response.json()) as {
    item?: MediaItem;
    usedIn?: UsedBy[];
    canEdit?: boolean;
  };
  if (!response.ok || !body.item) throw new Error(failure(body, "The file could not be loaded."));
  return { item: body.item, usedIn: body.usedIn ?? [], canEdit: Boolean(body.canEdit) };
}

export async function saveFile(
  id: string,
  patch: { alt: string; caption: string; title: string; description: string },
): Promise<void> {
  const response = await fetch(`/api/admin/media/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(failure(await response.json(), "It could not be saved."));
}

/** Puts a new file in place of this one. The address, the descriptions and the pages that use it stay. */
export async function replaceFile(id: string, file: File): Promise<void> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`/api/admin/media/${id}`, { method: "POST", body: form });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Not JSON: the fallback message is used.
    }
    throw new Error(failure(body, "The file could not be replaced. Try again."));
  }
}

export async function deleteFile(
  id: string,
): Promise<{ ok: true } | { ok: false; message: string; usedIn: UsedBy[] }> {
  const response = await fetch(`/api/admin/media/${id}`, { method: "DELETE" });
  if (response.ok) return { ok: true };
  const body = (await response.json()) as { error?: { message?: string }; usedIn?: UsedBy[] };
  return {
    ok: false,
    message: failure(body, "It could not be deleted."),
    usedIn: body.usedIn ?? [],
  };
}

/** A file as the library grid wants it. */
export function toLibraryItem(item: MediaItem): LibraryItem {
  const small = item.variants.find((v) => v.width === 320 && v.format === "webp");
  const isImage = item.mimeType.startsWith("image/");
  const size = item.width && item.height ? `${item.width} × ${item.height}` : undefined;
  return {
    id: item.id,
    name: item.fileName,
    type: item.mimeType,
    size: item.sizeBytes,
    ...(isImage ? { thumbnail: small?.url ?? item.url } : {}),
    ...(size ? { description: size } : {}),
  };
}

/** The address of a page or post's edit screen. */
export const editAddress = (use: UsedBy): string =>
  `/admin/${use.type === "post" ? "posts" : "pages"}/${use.id}`;
