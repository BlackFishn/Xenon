# Personal fork workflow

Read [INSTRUCTURE.md](../INSTRUCTURE.md) for the full project and agent guide.
The owner-selected flow is `upstream -> main -> production`, with features
branching from `production -> feat/* -> develop -> production`.

## Branch roles

| Branch | Purpose | Local checkout |
| --- | --- | --- |
| main | Track the selected upstream source | Inspect git worktree list before use |
| production | Tested daily-use code | F:/BrainSlop/xeon |
| develop | Completed features integrated for testing before promotion | F:/BrainSlop/xeon/.worktrees/develop |
| feat/<feature> or codex/<feature> | One feature or fix, based on production | A separate worktree |

The old dev branch/worktree is preserved as legacy pending work. Do not merge it
wholesale into develop or production; review its remaining changes separately.
Existing main and feature branches are preserved. Branch protection and the
GitHub default branch are not changed by this workflow.

## Finish a feature

1. Create a feature branch from production and work in an isolated checkout.
2. Test and commit the intended source changes; never commit private server/data,
   credentials, downloaded helpers or local runtime state.
3. Merge the finished feature into develop with a merge commit and push to origin
   (BlackFishn/Xenon). Every completed feature must reach this integration branch.
4. Test the combined result before promoting it to production. Record failures,
   compare them with the baseline, and keep unfinished work on feature branches.
5. When the integrated changes are ready, fast-forward production to develop and
   push production. If production advanced, merge production into develop and test
   again first. Do not force-push or reset away existing history.

Example from the root checkout, after the feature commit:

~~~powershell
rtk git -C .worktrees/develop merge --no-ff feat/my-feature
rtk git push origin develop
# After validation:
rtk git merge --ff-only develop
rtk git push origin production
~~~

Run git diff --check, node --check for changed JavaScript, npm test and relevant
build/feature checks. For UI changes, verify Edge, portrait and desktop layouts.

## Runtime and settings isolation

The daily-use backend must serve F:/BrainSlop/xeon/server on port 3030 and retain
its existing server/data. Each worktree has a separate data store. Changing the
backend path can make the app appear reset; never use a test worktree as the
production backend or copy its settings into the daily-use store.

Use a separate browser profile/context for test data. Before a runtime change,
back up the existing data and verify the served storeId and dashboard layout.
Do not clear browser storage or hand-edit server/data to change branches.

For a separate develop preview, run from .worktrees/develop:

~~~powershell
$env:XENON_PORT = '3031'
rtk proxy npm start
~~~

Open http://127.0.0.1:3031/ in the test browser context. Do not run npm run dev
on the default port: it clears 3030 and interrupts the daily-use backend. Native
tests also need explicit backend/profile isolation. Install dependencies and
shared links in the test checkout when necessary.

## Upstream and recovery

Upstream updates are performed when requested: fetch upstream, update main to the
selected revision, then merge main into production while preserving fork features.
Review conflicts and validate the result before publication/runtime changes; an
isolated worktree can stage this merge. Then merge production back into develop.
Do not reset production to main. This documents a workflow, not an automatic sync.
Publish only to origin, never upstream. Do not apply the upstream app updater to
this custom source installation; keep signed-update verification unchanged.

For a regression, revert the offending change and integrate the correction into
both develop and production. Preserve existing release tags, backups and native
artifacts. Git branches contain source code, not user settings or native builds.

## Integration validation: 2026-09-20

AI Usage live quotas, compact/grid layouts and the Power plan picker are integrated.
Focused tests: 29 passed. JavaScript syntax, diff checks and demo build passed.
Full suite: 3,466 tests, 3,451 passed, 5 failed and 10 skipped. All five failures
(stopwatch, update-handoff and three update-half-update tests) reproduce on the
previous production commit 7f7aca35; they are existing source-extraction failures.
The running native app displayed all five power plans and three dashboard pages;
its persisted settings matched the recovered backup, excluding the revision.

## Initial baseline: xenon-local-2026.09.14.1

Captured the current fork features in separate commits: AI Usage and quota
readings, subscription chat and voice, Ambient editing, FPS/network history,
audio freshness and callback fixes, native focus serialization, and StreamDock
Edge sleep/wake controls. Existing YouTube/dashboard/smart-home history remains.

Validation on Windows with Node 25.9.0:

- Changed JavaScript syntax: 46 files passed.
- Focused feature tests: 249 passed.
- Native unit tests: 24 passed.
- StreamDock plugin tests: 4 passed.
- Full suite in the daily-use checkout: 3,415 tests, 3,400 passed, 5 failed,
  10 skipped. The same five failures reproduce at the prior f21f1d19 baseline:
  stopwatch.test.mjs, update-handoff.test.mjs and three update-half-update tests.
  These source-extraction tests are sensitive to Windows line endings.
- The bottom placement of the Ambient editor toolbar adds a phone-dock layout
  failure. It is retained on dev; production retains the original top placement.
- A fresh isolated checkout also exposed community-catalog/Discord test failures;
  its full-suite result is kept with the local validation logs.
- The native focus race is fixed and covered by a regression test. The exact
  writer responsible for the earlier native heap corruption remains unconfirmed;
  this tag does not certify that every crash cause has been eliminated.

The release manifest records the final executable build and checksums. The
source archive contains tracked files, not credentials, local settings, helper
downloads or node_modules. This is a reproducible code checkpoint, not a complete
machine backup.

## Main integration: 2026-09-26

Integrated origin/main at `6413073c` (v4.11.9) into production, then synchronized
develop from production. The newer upstream/main was fetched for comparison only.
Spotify keeps the reviewed layout and volume behavior while accepting playable
Up Next rows. FPS keeps modern PresentMon, time-window pruning, swap-chain
isolation, tracked-game selection and mean-rate calculation while adding the
upstream present/display detail API.

Validation on Windows:
- Full integrated suite: 3,930 tests, 3,893 passed, 27 failed, 10 skipped.
- Unmodified main baseline with the same CRLF checkout: 3,702 tests,
  3,664 passed, 28 failed, 10 skipped. Every integrated failure also failed on
  main; the edited FPS documentation assertion additionally accepts CRLF.
- Focused Spotify/FPS integration tests: 110 passed, including queue context in duplicate widgets.
- Native unit tests: 25 passed. The no-bundle v4.11.9 release build passed.
- Dashboard demo build, 93 changed-JavaScript syntax checks and diff checks passed.
- Spotify mouse, keyboard and emulated touch volume plus Edge, portrait, compact,
  desktop, wrapped-title and tall-breakpoint layouts passed in an isolated browser.

A new native executable is required for all shell changes, including window backing
and platform-specific monitor/WebView recovery. It was built locally without
installing over the running app. The Windows helper and Game Bar sources did not
change in this main update, so they need no rebuild. Backend JavaScript changes
require restarting the production backend; frontend changes require a reload.
Source sync, binary installation and runtime restart remain separate operations.
