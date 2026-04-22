#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: fork-and-branch.sh REPO_URL REPO_NAME ISSUE_NUMBER" >&2
    exit 2
}

if [[ $# -ne 3 ]]; then
    usage
fi

REPO_URL="$1"
REPO_NAME="$2"
ISSUE_NUMBER="$3"

if [[ ! "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*/?$ ]]; then
    echo "error: REPO_URL must be https://github.com/<owner>/<repo>: $REPO_URL" >&2
    exit 2
fi

if [[ ! "$REPO_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "error: REPO_NAME is not a valid repo name: $REPO_NAME" >&2
    exit 2
fi

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "error: ISSUE_NUMBER must be a positive integer: $ISSUE_NUMBER" >&2
    exit 2
fi

BRANCH="fix/issue-${ISSUE_NUMBER}"

USER_LOGIN="$(gh api user --jq .login)"
if [[ -z "$USER_LOGIN" ]]; then
    echo "error: could not resolve current gh user login" >&2
    exit 1
fi
FORK_SLUG="${USER_LOGIN}/${REPO_NAME}"
FORK_URL="https://github.com/${FORK_SLUG}.git"

# 1. Fork only if one doesn't already exist for this user. Pre-checking avoids
#    version-dependent behavior of `gh repo fork` when the fork is present.
if ! gh repo view "$FORK_SLUG" >/dev/null 2>&1; then
    gh repo fork "$REPO_URL" --clone=false >/dev/null
fi

# 2. Add the `fork` remote only if missing.
if ! git remote get-url fork >/dev/null 2>&1; then
    git remote add fork "$FORK_URL"
fi

# 3. Fetch so any pre-existing branch state on the fork is visible locally.
git fetch fork

# 4. Branch handling: resume prior work if the branch already exists on the fork,
#    otherwise create a fresh branch from the current HEAD.
if git rev-parse --verify --quiet "refs/remotes/fork/${BRANCH}" >/dev/null; then
    git checkout -B "$BRANCH" "fork/${BRANCH}"
    git pull --ff-only fork "$BRANCH"
else
    git checkout -b "$BRANCH"
fi
