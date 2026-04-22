#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: push-and-pr.sh TITLE BODY REPO_OWNER REPO_NAME ISSUE_NUMBER REQUESTER" >&2
    exit 2
}

if [[ $# -ne 6 ]]; then
    usage
fi

TITLE="$1"
BODY="$2"
REPO_OWNER="$3"
REPO_NAME="$4"
ISSUE_NUMBER="$5"
REQUESTER="$6"

IDENT_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'

if [[ -z "$TITLE" ]]; then
    echo "error: TITLE must be non-empty" >&2
    exit 2
fi
if [[ ${#TITLE} -gt 120 ]]; then
    echo "error: TITLE exceeds 120 chars (got ${#TITLE})" >&2
    exit 2
fi
if [[ -z "$BODY" ]]; then
    echo "error: BODY must be non-empty" >&2
    exit 2
fi
if [[ ! "$REPO_OWNER" =~ $IDENT_RE ]]; then
    echo "error: REPO_OWNER is not a valid GitHub identifier: $REPO_OWNER" >&2
    exit 2
fi
if [[ ! "$REPO_NAME" =~ $IDENT_RE ]]; then
    echo "error: REPO_NAME is not a valid GitHub identifier: $REPO_NAME" >&2
    exit 2
fi
if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "error: ISSUE_NUMBER must be a positive integer: $ISSUE_NUMBER" >&2
    exit 2
fi
if [[ ! "$REQUESTER" =~ $IDENT_RE ]]; then
    echo "error: REQUESTER is not a valid GitHub username: $REQUESTER" >&2
    exit 2
fi

ISSUE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${ISSUE_NUMBER}"
BRANCH="fix/issue-${ISSUE_NUMBER}"
FULL_BODY="Resolves ${ISSUE_URL}

${BODY}"

USER_LOGIN="$(gh api user --jq .login)"
if [[ -z "$USER_LOGIN" ]]; then
    echo "error: could not resolve current gh user login" >&2
    exit 1
fi

git push -u fork "$BRANCH"

# Create the PR first. Any failure here is a real failure — don't hide it by
# retrying. Reviewer assignment is a separate step so it can fail independently
# without blocking PR creation.
PR_URL="$(gh pr create \
    --repo "${REPO_OWNER}/${REPO_NAME}" \
    --head "${USER_LOGIN}:${BRANCH}" \
    --draft \
    --title "$TITLE" \
    --body "$FULL_BODY")"

echo "$PR_URL"

# Requester as reviewer. This can legitimately fail (requester is the author,
# not a collaborator, etc.) — warn but don't error out, since the PR is already
# created and the reviewer is an "always try" invariant, not a hard requirement.
if ! gh pr edit "$PR_URL" --add-reviewer "$REQUESTER" >/dev/null; then
    echo "warning: could not add $REQUESTER as reviewer on $PR_URL" >&2
fi
