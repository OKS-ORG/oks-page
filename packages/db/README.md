# @oks-page/db

Database schema (Drizzle) for SQLite and PostgreSQL, from [spec 01](https://github.com/OKS-ORG/CMS-Docs) (`docs/specs/01-data-model.md`).

- `src/schema/sqlite.ts` and `src/schema/pg.ts`: the two schema definitions. They were generated once from the spec tables and are now edited by hand. The parity test (`schema.parity.test.ts`, DM-16) keeps them equal.
- `drizzle/sqlite` and `drizzle/pg`: generated migrations (`pnpm --filter @oks-page/db generate`). Do not edit by hand.
- `src/constraints.test.ts`: spec 01 tests DM-01 to DM-15 and DM-28 to DM-31 on both databases.
- PostgreSQL tests need `DATABASE_URL`. In CI it is set. Without it, the PostgreSQL runs are skipped on a developer machine.
