# Secrets and repository history

## Usage logger configuration

Usage logging is disabled unless all required values are configured:

```dotenv
TIMEKEEPER_USAGE_LOG_ENABLED=1
TIMEKEEPER_USAGE_LOG_URL=https://example.invalid/usage
TIMEKEEPER_USAGE_LOG_AUTHORIZATION=Token replace-me
TIMEKEEPER_USAGE_LOG_APPLICATION_NAME=Time-Keeper
```

For source runs, put these values in the ignored repository-root `.env`. For an
installed build, put them in `%LOCALAPPDATA%\TimeKeeper\.env`. Alternatively,
set `TIMEKEEPER_ENV_FILE` to a private file elsewhere. Process environment
variables always take precedence over values in the file.

The logger stays disabled when configuration is absent and logging failures do
not stop application startup. Never add a real value to `.env.example`.

## Rotate the exposed credential first

The previous authorization value entered Git history on January 27, 2026 in
commit `2d2d144`. It appears in 36 commits reachable from `main` and
`origin/main`; no tags currently contain it. Removing history does not revoke
copies, forks, caches, or existing clones. Revoke that value at the receiving
service and create a new, least-privilege value before rewriting history.

## Rewrite the affected Git history

The repository includes an interactive Git Bash wrapper for this exact cleanup:

```bash
bash scripts/purge-usage-logger-history.sh
```

It commits and normally pushes the currently staged release work, creates a
private recovery bundle and fresh clone, performs and verifies the rewrite, and
requires an exact confirmation phrase immediately before the force-push. It
never deletes the original clone or its ignored `.env`.

The manual equivalent follows for review and recovery purposes.

An interactive rebase is not appropriate for 36 affected commits. Use
`git-filter-repo` from a fresh clone after coordinating downtime with every
collaborator. Finish and back up all local work first. GitHub requires
`git-filter-repo` 2.47 or newer for the sensitive-data workflow.

1. Install the latest release from the
   [official git-filter-repo project](https://github.com/newren/git-filter-repo).
2. Create a fresh clone beside the normal working copy:

   ```powershell
   git clone https://github.com/Matthew-05/Time-Keeper.git Time-Keeper-clean
   Set-Location Time-Keeper-clean
   ```

3. Create a temporary file outside the mirror containing the exact revoked
   authorization value followed by `==><REMOVED>`. Do not place or commit this
   replacement file inside either repository.
4. Rewrite every ref and inspect the result:

   ```powershell
   git-filter-repo --sensitive-data-removal --replace-text C:\private\replacements.txt
   git log --all -S "the-revoked-value" --oneline
   ```

   The verification command must print nothing. Delete the replacement file
   securely when finished.
5. `git-filter-repo` normally removes `origin` as a safety measure. Restore it,
   then force-push the rewritten refs only after reviewing the mirror:

   ```powershell
   git remote add origin https://github.com/Matthew-05/Time-Keeper.git
   git push --force --mirror origin
   ```

6. Have every collaborator delete old clones and clone again. Do not merge an
   old branch after the rewrite because it will reintroduce the removed history.

GitHub may retain cached views, pull-request refs, or forks outside the
repository owner's direct control. Follow GitHub's
[sensitive-data removal process](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
after the force-push, including checking `.git/filter-repo/changed-refs` and
contacting GitHub Support when cached views or pull requests are affected.
