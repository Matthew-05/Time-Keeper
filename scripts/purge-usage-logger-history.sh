#!/usr/bin/env bash
# Publish the current Time Keeper release-prep work, then remove the revoked
# UsageLogger authorization value from reachable Git history.
#
# Run this from Git Bash at the Time-Keeper repository root:
#   bash scripts/purge-usage-logger-history.sh

set -Eeuo pipefail

REPOSITORY_URL="https://github.com/Matthew-05/Time-Keeper.git"
EXPECTED_BRANCH="main"
INTRODUCING_COMMIT="2d2d144"
COMMIT_MESSAGE="Prepare first release and secure telemetry configuration"
FORCE_CONFIRMATION="FORCE-PUSH REWRITTEN HISTORY"

replacement_file=""

cleanup() {
    if [[ -n "${replacement_file:-}" && -f "$replacement_file" ]]; then
        rm -f -- "$replacement_file"
    fi
}
trap cleanup EXIT

die() {
    printf '\nERROR: %s\n' "$*" >&2
    exit 1
}

step() {
    printf '\n==> %s\n' "$*"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command '$1' was not found."
}

find_user_git_filter_repo() {
    command -v git-filter-repo >/dev/null 2>&1 && return 0

    # pip --user installs console scripts outside PATH on many Windows setups.
    # First inspect the standard roaming-profile location; this also works when
    # the Python launcher is visible but cannot enumerate installs in Git Bash.
    local appdata_path=""
    local candidate=""
    if [[ -n "${APPDATA:-}" ]] && command -v cygpath >/dev/null 2>&1; then
        appdata_path="$(cygpath -u "$APPDATA")"
        for candidate in "$appdata_path"/Python/Python*/Scripts/git-filter-repo.exe; do
            [[ -x "$candidate" ]] || continue
            export PATH="$(dirname "$candidate"):$PATH"
            command -v git-filter-repo >/dev/null 2>&1 && return 0
        done
    fi

    # Ask the same Python launcher that installed the package for its user base,
    # translate the Windows path for Git Bash, and retry without changing the
    # user's permanent environment.
    local python_launcher=""
    local user_base=""
    local scripts_dir=""
    for python_launcher in py.exe py python.exe python; do
        command -v "$python_launcher" >/dev/null 2>&1 || continue
        user_base="$("$python_launcher" -m site --user-base 2>/dev/null | tr -d '\r')" || true
        [[ -n "$user_base" ]] || continue
        if command -v cygpath >/dev/null 2>&1; then
            scripts_dir="$(cygpath -u "$user_base")/Scripts"
        else
            scripts_dir="$user_base/Scripts"
        fi
        [[ -x "$scripts_dir/git-filter-repo.exe" || -x "$scripts_dir/git-filter-repo" ]] || continue
        export PATH="$scripts_dir:$PATH"
        command -v git-filter-repo >/dev/null 2>&1 && return 0
    done
    return 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    die "Run this from inside the Time-Keeper Git repository."
cd "$repo_root"

[[ "$(basename "$repo_root")" == "Time-Keeper" ]] ||
    die "Expected the repository directory to be named Time-Keeper."
[[ "$(git branch --show-current)" == "$EXPECTED_BRANCH" ]] ||
    die "Run this from the main branch."

require_command git
require_command mktemp
find_user_git_filter_repo || die \
    "git-filter-repo was not found, including the current Python user's Scripts directory."

step "Confirming the revoked credential"
printf '%s\n' \
    "Before continuing, revoke the old UsageLogger credential at the receiving service." \
    "This script will never print or copy it into the current source tree."
read -r -p "Type REVOKED to confirm the old credential is disabled: " revoked_confirmation
[[ "$revoked_confirmation" == "REVOKED" ]] || die "Credential revocation was not confirmed."

step "Checking private configuration"
git check-ignore --quiet .env || die ".env is not ignored."
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    die ".env is tracked. Remove it from the index before continuing."
fi
if git check-ignore --quiet .env.example; then
    die ".env.example is incorrectly ignored."
fi

step "Preparing the current release-prep commit"
# Stage only the history-cleanup script and its documentation, which were added
# after the user staged the reviewed release-prep changes. Never use a catch-all
# git add here.
git add -- scripts/purge-usage-logger-history.sh docs/SECRETS.md

if ! git diff --quiet; then
    git status --short
    die "Unstaged tracked changes remain. Stage or revert them, then rerun."
fi

untracked="$(git ls-files --others --exclude-standard)"
[[ -z "$untracked" ]] || {
    printf '%s\n' "$untracked" >&2
    die "Untracked non-ignored files remain. Review them before continuing."
}

git diff --cached --check
if git diff --cached --quiet; then
    printf '%s\n' "No staged changes need a new commit."
else
    git commit -m "$COMMIT_MESSAGE"
fi

[[ -z "$(git status --porcelain)" ]] || die "The worktree is not clean after committing."

step "Publishing the current main branch normally"
git fetch origin
read -r behind ahead < <(git rev-list --left-right --count origin/main...HEAD)
[[ "$behind" == "0" ]] ||
    die "origin/main has commits not in this clone. Stop and reconcile them before rewriting history."
printf 'Local main is %s commit(s) ahead of origin/main.\n' "$ahead"
git push origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
    die "The normal push did not synchronize main and origin/main."

step "Creating a private recovery bundle"
timestamp="$(date +%Y%m%d-%H%M%S)"
parent_dir="$(dirname "$repo_root")"
bundle_path="$parent_dir/Time-Keeper-before-history-rewrite-$timestamp.bundle"
git bundle create "$bundle_path" --all
git bundle verify "$bundle_path"
printf 'Private recovery bundle: %s\n' "$bundle_path"
printf '%s\n' "It contains the revoked history; delete it after the cleanup is verified."

step "Creating a fresh cleanup clone"
clean_dir="$parent_dir/Time-Keeper-history-clean-$timestamp"
[[ ! -e "$clean_dir" ]] || die "Cleanup directory already exists: $clean_dir"
git clone "$REPOSITORY_URL" "$clean_dir"
cd "$clean_dir"
remote_head_before="$(git rev-parse origin/main)"

step "Extracting the historical value without displaying it"
historic_source="$(git show "$INTRODUCING_COMMIT:main.py")" ||
    die "Could not read main.py from historical commit $INTRODUCING_COMMIT."
revoked_credential="$(
    printf '%s\n' "$historic_source" |
        sed -n "s/.*'Authorization'[[:space:]]*:[[:space:]]*'\([^']*\)'.*/\1/p" |
        head -n 1
)"
unset historic_source
[[ -n "$revoked_credential" ]] || die "Could not identify the historical authorization value."

replacement_file="$(mktemp "${TMPDIR:-/tmp}/timekeeper-replacements.XXXXXX")"
chmod 600 "$replacement_file" 2>/dev/null || true
printf '%s==>***REMOVED***\n' "$revoked_credential" > "$replacement_file"

step "Rewriting the fresh clone"
git-filter-repo \
    --sensitive-data-removal \
    --replace-text "$replacement_file"

step "Verifying the historical value is gone"
remaining="$(git log --all -S"$revoked_credential" --oneline)"
[[ -z "$remaining" ]] || {
    printf '%s\n' "$remaining" >&2
    die "The revoked value remains in reachable history. Nothing was force-pushed."
}
[[ -z "$(git status --porcelain)" ]] || die "The rewritten clone is not clean."
printf '%s\n' "The revoked value no longer appears in reachable history."

changed_refs_file=".git/filter-repo/changed-refs"
if [[ -f "$changed_refs_file" ]]; then
    affected_prs="$(grep -c '^refs/pull/' "$changed_refs_file" || true)"
    printf 'Affected fetched pull-request refs: %s\n' "$affected_prs"
fi

step "Checking that GitHub did not change during cleanup"
remote_head_now="$(git ls-remote "$REPOSITORY_URL" refs/heads/main | awk '{print $1}')"
[[ -n "$remote_head_now" ]] || die "Could not read origin/main from GitHub."
[[ "$remote_head_now" == "$remote_head_before" ]] ||
    die "origin/main changed during cleanup. Nothing was force-pushed."

printf '\nThe rewritten clone is ready at:\n  %s\n' "$clean_dir"
printf '%s\n' \
    "The next command replaces GitHub history and changes historical commit IDs." \
    "Do not continue if another person or automation may be pushing to this repository."
read -r -p "Type '$FORCE_CONFIRMATION' to continue: " force_confirmation
[[ "$force_confirmation" == "$FORCE_CONFIRMATION" ]] ||
    die "Force-push cancelled. The original repository and GitHub were not rewritten."

step "Force-pushing the rewritten refs"
# git-filter-repo removes origin as a safety measure.
if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REPOSITORY_URL"
else
    git remote add origin "$REPOSITORY_URL"
fi
git push --force --mirror origin

local_clean_head="$(git rev-parse main)"
remote_clean_head="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "$local_clean_head" == "$remote_clean_head" ]] ||
    die "GitHub main does not match the rewritten local main."

cleanup
replacement_file=""
unset revoked_credential

printf '\nSUCCESS: GitHub main now uses the rewritten, cleaned history.\n\n'
printf 'Clean replacement clone:\n  %s\n\n' "$clean_dir"
printf 'Original clone retained as a safety copy:\n  %s\n\n' "$repo_root"
printf '%s\n' \
    "Next steps:" \
    "  1. Close GitHub Desktop." \
    "  2. Copy your ignored .env from the original clone if needed." \
    "  3. Stop using the original clone; add the clean clone to GitHub Desktop." \
    "  4. After verification, delete the original clone and recovery bundle because both contain old history." \
    "  5. Contact GitHub Support if changed-refs reported pull requests or cached views need purging."
