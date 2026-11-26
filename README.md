# oks-page

A WordPress alternative built with Next.js. You write pages and posts in a block editor, keep pictures in a library, choose a theme, add plugins that run in a sandbox, and publish from one admin. It runs on your own server with SQLite (nothing to set up) or PostgreSQL.

**Status: public beta (0.1.0-beta).** It works and is tested, but it is young. An outside security review has not been done yet, so think before you put a site on it that must hold secrets or be perfectly safe, and keep your backups (the admin makes one every day).

## Start a site

You need [Node.js](https://nodejs.org) 22 or later.

```bash
npm create oks-page@beta my-site
cd my-site
npm run dev
```

Then open <http://localhost:3000/admin/setup> and follow the three steps. PostgreSQL instead of SQLite: `npm create oks-page@beta my-site -- --db postgres --database-url postgres://user:password@host/db`.

## What is in it

- **Writing:** pages and posts, a writing editor and a layout editor made of blocks, saved copies you can go back to, scheduled publishing, a trash, and comments.
- **Pictures and files:** a media library that checks every upload, makes the sizes, and cleans pictures with scripts in them.
- **Look:** themes with their own layouts, your own colors and fonts, saved sections, and a theme you can export and install again.
- **Plugins:** they run in a sandbox with only the rights they ask for. A forms plugin and a business plugin (opening hours, bookings, reviews, a map) come with it.
- **Search engines and speed:** sitemaps, feeds, structured data, redirects, and a static export or publish to Netlify, GitHub Pages or an SFTP server.
- **Privacy:** no cookies by default, visitor statistics without cookies, a consent notice, privacy requests, and imprint and accessibility statement drafts.
- **People:** roles from Administrator to Subscriber and a Client role for the owner of a site you built, two-factor sign-in and passkeys.
- **Keeping it safe:** a daily backup of the whole site that checks itself, restore with a safety copy, and a site bundle to give a site away or copy it.
- **For freelancers and agencies:** a handoff checklist, client content links, white-label admin, and (with an Agency licence key, not on sale yet) a dashboard for many client sites with reports.

## What is not here yet

Updating the software from the admin (today you update the packages and rebuild), a marketplace, several languages on one site, and the outside security review. The software is tested on Linux with Node.js 22; Node 24 and 26, Windows and Docker are not verified yet.

## Help and contributions

- A problem or a question: open an issue.
- A security problem: please report it in private, as [SECURITY.md](SECURITY.md) says. Do not open a public issue.
- A change: read [CONTRIBUTING.md](CONTRIBUTING.md). Every commit needs a `Signed-off-by` line.
- How we treat each other: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

MIT, see [LICENSE](LICENSE).
