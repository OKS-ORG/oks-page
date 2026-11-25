# @oks-page/db

Database schema (Drizzle) for SQLite and PostgreSQL, from spec 01 (the data model).

- `src/schema/sqlite.ts` and `src/schema/pg.ts`: the two schema definitions. They were generated once from the spec tables and are now edited by hand. The parity test (`schema.parity.test.ts`, DM-16) keeps them equal.
- `drizzle/sqlite` and `drizzle/pg`: generated migrations (`pnpm --filter @oks-page/db generate`). Do not edit by hand.
- `src/constraints.test.ts`: spec 01 tests DM-01 to DM-15 and DM-28 to DM-31 on both databases.
- PostgreSQL tests need `DATABASE_URL`. In CI it is set. Without it, the PostgreSQL runs are skipped on a developer machine.

This is a building block of [oks-page](https://github.com/OKS-ORG/oks-page). Most people do not install it directly: start a site with `npm create oks-page@beta my-site`.

Licence: MIT.
