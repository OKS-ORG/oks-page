"use client";
// The admin shell around a screen: the menu, the footer, who is signed in and Sign out.
import { Shell } from "@oks-page/admin";
import "@oks-page/admin/shell.css";
import { Button } from "oks-ui";
import type { ReactNode } from "react";
import type { NavItem } from "./admin-nav";

async function signOut() {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  window.location.assign("/admin/login");
}

export interface AdminFrameProps {
  user: { name: string; email: string };
  /** The menu for this person (see `navFor`). */
  nav: NavItem[];
  product: string;
  version: string;
  selectedKey: string;
  title: string;
  breadcrumbs?: { label: string; href?: string }[];
  children: ReactNode;
}

export function AdminFrame({
  user,
  nav,
  product,
  version,
  selectedKey,
  title,
  breadcrumbs,
  children,
}: AdminFrameProps) {
  return (
    <Shell
      nav={nav}
      selectedKey={selectedKey}
      title={title}
      {...(breadcrumbs ? { breadcrumbs } : {})}
      footer={{ product, version }}
    >
      <p>
        Signed in as {user.name} ({user.email}){" "}
        <Button onPress={() => void signOut()}>Sign out</Button>
      </p>
      {children}
    </Shell>
  );
}
