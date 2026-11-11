"use client";
// The state of a library list in the browser: the search and type filter, paging, and uploads with their messages.
// The library screen and the picker in the editor both use it.
import { useCallback, useEffect, useRef, useState } from "react";
import { loadLibrary, uploadFile, type LibraryKind, type MediaItem } from "./media-client";

export interface UploadNote {
  key: number;
  name: string;
  state: "uploading" | "done" | "failed";
  progress: number;
  message?: string;
}

export function useLibrary(initial?: { items: MediaItem[]; total: number }) {
  const [items, setItems] = useState<MediaItem[]>(initial?.items ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<LibraryKind>("all");
  const [loading, setLoading] = useState(!initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadNote[]>([]);
  const controller = useRef<AbortController | null>(null);
  const first = useRef(Boolean(initial));
  const counter = useRef(0);

  const reload = useCallback(async (opts: { search: string; kind: LibraryKind }) => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setLoading(true);
    setProblem(null);
    try {
      const page = await loadLibrary({ ...opts, signal: mine.signal });
      setItems(page.items);
      setTotal(page.total);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setProblem((error as Error).message);
    }
    setLoading(false);
  }, []);

  // A new search or filter loads the first page again (not on the first draw when the server sent the list).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void reload({ search, kind }), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search, kind, reload]);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const page = await loadLibrary({ search, kind, offset: items.length });
      setItems((current) => [
        ...current,
        ...page.items.filter((i) => !current.some((c) => c.id === i.id)),
      ]);
      setTotal(page.total);
    } catch (error) {
      setProblem((error as Error).message);
    }
    setLoading(false);
  }, [search, kind, items.length]);

  /** Uploads the files one after the other. Resolves with the ids of the files that were stored. */
  const upload = useCallback(
    async (files: File[]): Promise<string[]> => {
      const made: string[] = [];
      for (const file of files) {
        const key = ++counter.current;
        const patch = (change: Partial<UploadNote>) =>
          setUploads((all) => all.map((n) => (n.key === key ? { ...n, ...change } : n)));
        setUploads((all) => [...all, { key, name: file.name, state: "uploading", progress: 0 }]);
        try {
          const result = await uploadFile(file, { onProgress: (progress) => patch({ progress }) });
          patch({ state: "done", progress: 1 });
          made.push(result.id);
        } catch (error) {
          patch({ state: "failed", message: (error as Error).message });
        }
      }
      if (made.length > 0)
        await reload({ search: "", kind: "all" }).then(() => {
          setSearch("");
          setKind("all");
        });
      return made;
    },
    [reload],
  );

  const dismissUpload = (key: number) => setUploads((all) => all.filter((n) => n.key !== key));

  return {
    items,
    total,
    search,
    setSearch,
    kind,
    setKind,
    loading,
    problem,
    uploads,
    dismissUpload,
    loadMore,
    upload,
    reload: () => reload({ search, kind }),
    hasMore: items.length < total,
  };
}
