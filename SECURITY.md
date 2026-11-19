# Security policy

Thank you for helping to keep this project and the sites built with it safe.

## Report a problem in private

**Please do not open a public issue, a pull request or a discussion for a security problem.** Anyone could read it before there is a fix.

Use GitHub's private reporting instead:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability**, or go straight to
   <https://github.com/OKS-ORG/oks-page/security/advisories/new>.
3. Write what you found (see below) and send it. Only the maintainers can read it.

If you cannot use GitHub, open a normal issue that says only "I have a security report, please tell me how to send it", with no details. A maintainer will answer with a private way to send it.

### What to put in the report

- What you found, and what a person could do with it (read someone's data, sign in as someone else, run code, …).
- The steps to repeat it, as short as you can make them.
- The version or the commit you tried, and the database (SQLite or PostgreSQL) and how it runs (Node.js or Docker).
- Anything else that helps: a screenshot, a small test, a suggested fix.

Please test only on **your own installation**, never on someone else's site, and do not read, change or keep data that is not yours.

## What happens next

- **We answer within 3 days.** You will hear from a maintainer to say we got it and whether we can repeat it.
- **We have a fix, or a clear plan with a date, within 30 days.** Critical problems (someone can take over a site, run code, or read data they must not see) are fixed faster. We will tell you when a fix is ready.
- **We make the problem public within 90 days at the latest.** If the fix is ready sooner, the notice comes with it. If attackers are already using the problem, we shorten these times.
- **We tell the people who run sites.** A fix for a security problem is published together with a notice that says which versions are affected and which version fixes it (a GitHub security advisory). An urgent security update path in the update checks is planned for this; until it exists, the notice is the way.
- **We ask you to keep the report private until the fix is out**, and we are glad to name you in the notice if you want to be named.

## Which versions get fixes

| Version                                     | Fixes for security problems |
| ------------------------------------------- | --------------------------- |
| The latest release                          | Yes                         |
| The previous major version                  | Yes                         |
| Older versions                              | No: please update           |
| The code on `main` before the first release | Yes, on `main` only         |

There is no release yet: the project is in development and nothing is published. Until version 1.0, fixes go to `main`.

## What is in scope

- The code in this repository: the core, the admin, sign-in and roles, media and uploads, the installer and the command line (`oks`), and the default theme.
- A weakness in how the project's own pieces fit together, for example a way around the permission checks, or a way to get a file or an address served that should not be.

Not in scope here:

- A plugin or a theme made by someone else: please tell its author (and the marketplace, once there is one).
- A problem that needs someone to already have the server, or an administrator's password.
- Reports that only say a header or a setting is missing without a way to use it.
- Overloading a site with a flood of requests.
- Tricking a person into doing something (phishing, social engineering).

If you are not sure, report it anyway. We would rather read a report that turns out to be nothing.
