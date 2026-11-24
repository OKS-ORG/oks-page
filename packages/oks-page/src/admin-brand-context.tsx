"use client";
// The admin's own name, logo, help link, footer line and brand color (white-label, spec 11, section 5), put once around every
// admin page by the admin layout, so each screen does not have to ask for it.
import { createContext, useContext, type ReactNode } from "react";

export interface AdminBrandValue {
  /** The name of the admin, or empty for the product's own. */
  name: string;
  logoUrl: string | null;
  helpHref: string | null;
  footerText: string | null;
  /** The style rules of the brand color: the light and the dark scale of oks-ui's primary color, or null. */
  colorCss: string | null;
}

export const NO_BRAND: AdminBrandValue = {
  name: "",
  logoUrl: null,
  helpHref: null,
  footerText: null,
  colorCss: null,
};

const Context = createContext<AdminBrandValue>(NO_BRAND);

export function AdminBrandProvider({
  brand,
  children,
}: {
  brand: AdminBrandValue;
  children: ReactNode;
}) {
  return (
    <Context.Provider value={brand}>
      {/* Only colors, made by the core from a checked "#rrggbb": nothing the owner typed is written here. */}
      {brand.colorCss ? <style dangerouslySetInnerHTML={{ __html: brand.colorCss }} /> : null}
      {children}
    </Context.Provider>
  );
}

export const useAdminBrand = (): AdminBrandValue => useContext(Context);
