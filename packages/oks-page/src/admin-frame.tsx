"use client";
// The admin shell around a screen: the menu, the footer, who is signed in and Sign out.
import { Shell } from "@oks-page/admin";
import "@oks-page/admin/shell.css";
import { Button } from "oks-ui";
import type { ReactNode } from "react";

export const NAV = [
  { key: "home", label: "Home", href: "/admin" },
  { key: "pages", label: "Pages", href: "/admin/pages" },
  { key: "posts", label: "Posts", href: "/admin/posts" },
  { key: "media", label: "Media", href: "/admin/media" },
];

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
  product: string;
  version: string;
  selectedKey: string;
  title: string;
  breadcrumbs?: { label: string; href?: string }[];
  children: ReactNode;
}

export function AdminFrame({
  user,
  product,
  version,
  selectedKey,
  title,
  breadcrumbs,
  children,
}: AdminFrameProps) {
  return (
    <Shell
      nav={NAV}
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
