# Contributing to ShadowMail

## Layout

- `app/main/` — the Electron main process (ESM): windows, IPC handlers, the sync manager, the MCP server for Claude
  access. `app/main/main.js` sets the data paths first, then takes the single-instance lock.
- `app/preload/preload.cjs` — the narrow IPC bridge (`window.shadowMail`); a sandboxed preload, so CommonJS.
- `app/renderer/` — the interface: React, built by Vite into `out/renderer/`. All visible text is in
  `app/renderer/i18n/hu.js` (the interface is Hungarian for now). Colours and sizes only in `src/theme.css`.
- `core/` — plain Node, no Electron: the encrypted database and its migrations (`core/db/`), IMAP and POP3
  (`core/imap/`, `core/pop3/`), MIME and the visible-text filter (`core/mime/`), SMTP, the vault (`core/vault/`).
  Everything here is testable with `node:test`.
- `test/` — unit tests (`*.test.js`, run by `npm test`), app tests in `test/e2e/`, fakes in `test/helpers/` (an
  IMAP-like fake client, a real TCP POP3 fake, local SMTP), fixtures in `test/fixtures/`.
- `scripts/` — the Windows build (`build-win.sh` from WSL, `win/`), screenshots, the public-tree check, the
  third-party notices.

## Running

- `npm ci`, then `npm start` (builds the renderer and starts Electron with the data folder `./data-dev`).
- `SHADOWMAIL_DATA=<folder>` uses another data folder.
- Windows package: `npm run dist:win` (on Windows) or `scripts/build-win.sh` (from WSL); the zip goes to `dist/`.

## Tests

- `npm test` — every unit test (`node --test "test/**/*.test.js"`). No network: the servers are fakes. It also runs
  the public tree check on the tree (`test/public-tree.test.js`): in a public clone, which has no local deny list, every
  category except the local names, and the test says so in its output.
- App tests: `node test/e2e/<name>-e2e.mjs`, headless Electron driven by Playwright. `playwright-core` is a
  devDependency; set `PW=<path of another playwright package>` to use a different one. On Linux without a display
  they run headless (`--ozone-platform=headless`). Build the renderer first (`npx vite build`): the app loads
  `out/renderer/`.
- Screenshots with test data: `node scripts/ui-screenshots.mjs <prefix> [--set readme] [--out <folder>]`.
- A change to the interface needs its app test; a change to `core/` needs its unit test. A fix comes with a test
  that fails without it.

## Rules for the source

- **Public tree check:** part of `npm test`; on its own `npm run check:public -- --allow-missing-local` in a public
  clone (`scripts/public-check.mjs`; without the flag it also wants a local, untracked deny list, which only the
  original repository has). It must report nothing. It looks for
  internal references in comments, test titles and console output (people's or tools' names, ticket or message
  numbers, plan points, commit hashes) and in file names, personal paths and names, real e-mail addresses (only `example`, `invalid`, `test` and
  `localhost` domains are allowed), secrets, and a missing license line. Keep the WHY in a comment, in plain English;
  tracking (which ticket, which review) belongs in the commit message.
- **Public export** (the original repository only): `node scripts/public-export.mjs <ref> <new folder>` writes the
  tree of `<ref>` without the paths that stay private (`publish.json` `exclude`), as `git archive` gives it, and runs
  the public tree check on it with the local deny list; if it finds anything, the folder is removed and the exit
  code is 1. It runs no git command in the folder: a release of the public repository is one commit of it.
- **License line:** every source file in `app/`, `core/` and `scripts/` starts with
  `SPDX-License-Identifier: GPL-3.0-or-later` in its comment form (after a shebang or a doctype).
- **Test data:** neutral names, `example.invalid` addresses, no real person, host or path.
- Code, comments and commit messages in English; the interface text in `app/renderer/i18n/`.
- No new dependency without a reason; versions are exact (`package-lock.json`). After a dependency change run
  `node scripts/third-party-notices.mjs` and commit `THIRD-PARTY-NOTICES.txt` (a unit test checks it).

## License

By contributing you agree that your contribution is licensed under `GPL-3.0-or-later`, like the rest of the program
(see [LICENSE](LICENSE)).
