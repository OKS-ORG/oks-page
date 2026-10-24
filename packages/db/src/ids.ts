import { monotonicFactory } from "ulidx";

const next = monotonicFactory();

/** A new id: a ULID, 26 characters, sortable by creation time (spec 01, design rule 1). */
export const newId = (): string => next();
