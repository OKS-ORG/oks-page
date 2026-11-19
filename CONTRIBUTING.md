# Contributing

Thank you for helping. This page tells you how to send a change.

## Before you start

- For a bug or a small fix, open a pull request.
- For something bigger (a new feature, a change to how something works), open an issue first and say what you want to do, so nobody works in vain.
- **Security problems are not reported here.** Please read [SECURITY.md](SECURITY.md) and report them in private.

## Sign every commit (DCO)

We use the Developer Certificate of Origin (DCO). It is a short promise that you wrote the change, or that you have the right to give it to this project under its licence. It needs no paperwork and no account with us.

You make the promise by adding one line to every commit message:

```
Signed-off-by: Your Name <your-email@example.com>
```

Git adds it for you when you commit with `-s`:

```
git commit -s -m "Fix the date in the footer"
```

Use your real name and an email address you can be reached at. The full text of the promise is at <https://developercertificate.org>.

A check on every pull request looks for this line in each commit. A pull request without it cannot be merged. The rule is for everyone, including the maintainers.

### I forgot the line

For the last commit:

```
git commit --amend -s --no-edit
git push --force-with-lease
```

For several commits on your branch (change `main` if your pull request targets another branch):

```
git rebase main --signoff
git push --force-with-lease
```

## Your pull request

- Keep it small and about one thing.
- Run the checks before you push: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` and `pnpm check:repo`.
- Say in the description what changed and why, in plain words, and what you did not test.
- Be kind. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
