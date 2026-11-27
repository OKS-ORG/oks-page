"use client";
// How the admin looks for the signed-in person, and the two small things the menu shows (comments waiting, an update waiting),
// put once around every admin page by the admin layout (like the brand), so each screen does not have to ask.
import { DEFAULT_APPEARANCE, type Appearance } from "@oks-page/core/appearance";
import { createContext, useContext, type ReactNode } from "react";

/** What the menu shows beside its items: the count of comments waiting, and whether an update is waiting. */
export interface MenuHints {
  commentsWaiting: number;
  updateWaiting: boolean;
}

export const NO_HINTS: MenuHints = { commentsWaiting: 0, updateWaiting: false };

const Context = createContext<{ appearance: Appearance; hints: MenuHints }>({
  appearance: DEFAULT_APPEARANCE,
  hints: NO_HINTS,
});

export function AdminAppearanceProvider({
  appearance,
  hints = NO_HINTS,
  children,
}: {
  appearance: Appearance;
  hints?: MenuHints;
  children: ReactNode;
}) {
  return <Context.Provider value={{ appearance, hints }}>{children}</Context.Provider>;
}

export const useAdminAppearance = (): Appearance => useContext(Context).appearance;
export const useMenuHints = (): MenuHints => useContext(Context).hints;
