# Personal fork workflow

This fork uses three branch roles:

| Branch | Purpose | Local checkout |
| --- | --- | --- |
| production | Reviewed daily-use baseline; promote tested changes here | F:\BrainSlop\xeon |
| dev | Integration and pending work | F:\BrainSlop\xeon\.worktrees\dev |
| codex/<feature> | One feature or fix, created from dev | Use the dev checkout or a separate worktree |

The running source backend serves the main checkout. Make future edits in the
dev worktree so saving frontend files does not immediately change the live app.
Existing feature branches and main are preserved. Branch names alone do not
enforce review or tests; no GitHub branch protection or remote default was changed.

## Start and integrate work

From the repository root:

~~~powershell
rtk git -C .worktrees/dev switch -c codex/my-feature
~~~

Edit and test in that worktree. Commit only intended source changes, then return
it to dev and merge the feature:

~~~powershell
rtk git -C .worktrees/dev switch dev
rtk git -C .worktrees/dev merge --no-ff codex/my-feature
~~~

The dev worktree has its own shared-code links. Dependencies currently resolve
from the parent checkout; run npm install in dev when changing dependencies.
Do not copy production's private server/data or helper binaries into commits.

For a separate browser preview, run these commands **from the dev worktree**:

~~~powershell
$env:XENON_PORT = '3031'
rtk proxy npm start
~~~

Open http://127.0.0.1:3031/. Running npm run dev without an alternate port clears
port 3030 and can interrupt production. Native development needs its own backend
configuration; do not assume it uses the browser preview's port automatically.

## Promote a release

Review the diff from production. Run git diff --check, node --check on changed
JavaScript, npm test and relevant feature/native checks. Exercise affected screens
at the Edge, portrait and desktop sizes. Record failures and compare against the
previous baseline; a branch name is not proof of stability.

When every change on dev is ready, merge it into production in the main checkout:

~~~powershell
rtk git merge --ff-only dev
~~~

If dev contains unfinished changes, promote only reviewed feature commits
with git cherry-pick instead of merging the whole branch. Then merge production
back into dev so both branches retain the promoted history.

For native changes, stage an executable outside the running application's path:

~~~powershell
$env:CARGO_TARGET_DIR = 'F:\BrainSlop\xeon\.tmp\native-release'
rtk proxy npm run build --workspace @xenon/native -- --no-bundle
~~~

The root native:build script does not forward --no-bundle through its nested npm
invocation. Use the workspace command above for a local executable. Signed updater
packages additionally require the appropriate signing key; preserve updater
verification. Restart the app/backend as needed after promotion, then smoke-test.

Create a new annotated tag for each accepted baseline, such as
xenon-local-YYYY.MM.DD.N. Keep the source archive, executable, PDB, checksums and
validation record together under .local-releases/<tag>. These local artifacts are
ignored by Git. Do not reuse or move an existing release tag.

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

## Upstream and remote publishing

The upstream update remains deferred. When ready, fetch upstream, create a
codex/upstream-<version> branch from dev, merge the selected upstream tag/commit
there, resolve conflicts and validate before promotion. Do not merge upstream
directly into production. Keep main and the original branches unchanged.

Do not apply an upstream release through the app's updater to this custom source
installation when intending to keep local features. Use the branch workflow.
Updater signature checks remain unchanged.

The initial branch setup and release tag are local. Publish production, dev and
the chosen tag to origin explicitly when ready; do not push to upstream.

## Recover a known baseline

Inspect a release without moving the daily-use branch:

~~~powershell
rtk git worktree add --detach .worktrees/recovery xenon-local-2026.09.14.1
~~~

For a production regression, revert the offending commit on production, validate
and merge that correction back into dev. Reverting a merge requires selecting
its mainline parent. Avoid resetting away commits that may contain later work.

To restore the archived native executable, close Xenon normally first, verify the
manifest's SHA-256, and copy the archived executable to the normal launch path.
Keep its matching PDB for crash analysis. Restore compatible source alongside it;
configuration and external helper data are not rolled back by a Git tag.
