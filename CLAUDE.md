# CLAUDE.md

> Code repository guide. Started 23 October 2026 from the [M1 plan](https://github.com/OKS-ORG/oks-page-docs) (`docs/08-m1-plan.md`) and the [documentation repository's CLAUDE.md](https://github.com/OKS-ORG/oks-page-docs) (`CLAUDE.md`). Change anything that does not match the founder's wishes.

Guidance for Claude (and anyone) working in this repository. This repository holds the **code** for oks-page (final name since 11 November 2026, D144), a modern, open-source content management system built with Next.js, Tailwind CSS or custom CSS, and oks-ui. The **research, specifications and decisions live in the documentation repository** `OKS-ORG/oks-page-docs`. Code follows the approved specs there.

## Read first

1. `HANDOFF.md` in the documentation repository: where the work stopped
2. `docs/08-m1-plan.md` there: what M1 builds, the spikes and their tests
3. The spec for the module you touch (`docs/specs/NN-*.md`) and its acceptance tests
4. `docs/06-open-questions.md` there: every decision made so far

## The founder's rules

- **Document before code.** A change that contradicts an approved spec is written as a spec change and approved first.
- **Research before any conclusion. Never assume.** Check primary sources (official docs, package source and types) and test. Label recommendations as recommendations.
- **oks-ui is the founder's own library.** Check the installed package before saying what it has or lacks. Fix problems at the source (oks-ui) and keep our own checks as well (ADR 0019). Do not fork it.
- **Tests come from the specs.** Use the acceptance-test IDs (DM-, AU-, EC-, PB-, AD-, SEO-, MD-, ST-, AG-, RTL-) in test names. A spike is small and may be thrown away, but **its tests are kept**.
- **Plain, simple English** in documents and messages. The founder's first language is not English.

## Commands

`pnpm install`, then:

- `pnpm ci`: everything below in one go (what CI runs)
- `pnpm test`, `pnpm lint`, `pnpm format`, `pnpm typecheck`
- `pnpm check:repo`: the repo checks in `scripts/checks/` (one copy of React, no `blocksToHtml`, product name only in `brand.json`)
- `pnpm test:pg` and `pnpm test:docker`: placeholders until S2 and S5

The product name lives in `brand.json`. Package scope is `@oks-page/*`.

## Conventions

- pnpm workspaces and Turborepo; TypeScript strict; ESLint; Prettier; Vitest; Playwright; Changesets.
- Node.js 22, 24 and 26 are all tested. Do not use a feature that only exists in one of them.
- **The product name and the command name** live in one place (`brand.json`); never write it elsewhere as a string. Nothing is published to npm in M1.
- Two database schemas (SQLite and PostgreSQL) are kept equal by the parity test. Every sort or filter on a custom field goes through the one query builder.
- Public and stored HTML is made only by our own writer. Never use oks-ui's `blocksToHtml` for it. Every write of block content passes the block checks.
- Public pages never contain `'use cache'` directly: data goes through the aliased data module (server and export builds differ in one file).
- No inline styles in generated page CSS; styles use start/end (logical) properties, not left/right (spec 12).
- No cookies by default; nothing contacts another company without the owner's choice.
- Never put AI model names in commit messages or documents.

## Git

- Work on the branch the session names. Commit with clear messages. One pull request per spike.
- Do not push to `main` directly (the first commit was the only exception). Do not publish packages.
