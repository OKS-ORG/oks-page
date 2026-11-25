# create-oks-page

Creates a new oks-page site: asks a few questions, writes the project, installs its dependencies.

```bash
npm create oks-page@beta my-site
```

Needs Node.js 22 or later. Options:

```
--db sqlite|postgres      The database. Default: sqlite (no server needed).
--database-url <url>      For PostgreSQL: postgres://user:password@host/db
--storage local           Where uploads go. Default: local (./uploads).
--package-manager <name>  npm, pnpm or yarn. Default: the one that started this command.
--no-install              Write the files and stop: install the dependencies yourself.
--yes, -y                 Do not ask questions; use the defaults.
```

When it is done, `cd` into the folder, run `npm run dev`, and open `/admin/setup` to finish the setup.

More: <https://github.com/OKS-ORG/oks-page#readme>. Licence: MIT.
