"use client";
// The admin's own name, logo, help link and footer line (white-label, spec 11, section 5), put once around every admin page by
// the admin layout, so each screen does not have to ask for it.
import { createContext, useContext, type ReactNode } from "react";

export interface AdminBrandValue {
  /** The name of the admin, or empty for the product's own. */
  name: string;
  logoUrl: string | null;
  helpHref: string | null;
  footerText: string | null;
}

export const NO_BRAND: AdminBrandValue = {
  name: "",
  logoUrl: null,
  helpHref: null,
  footerText: null,
};

const Context = createContext<AdminBrandValue>(NO_BRAND);

export function AdminBrandProvider({
  brand,
  children,
}: {
  brand: AdminBrandValue;
  children: ReactNode;
}) {
  return <Context.Provider value={brand}>{children}</Context.Provider>;
}

export const useAdminBrand = (): AdminBrandValue => useContext(Context);
