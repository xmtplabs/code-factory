#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: read-issue.sh ISSUE_URL" >&2
    echo "  ISSUE_URL must match https://github.com/<owner>/<repo>/issues/<number>" >&2
    exit 2
}

if [[ $# -ne 1 ]]; then
    usage
fi

ISSUE_URL="$1"

if [[ ! "$ISSUE_URL" =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*/issues/[0-9]+$ ]]; then
    echo "error: ISSUE_URL is not a valid GitHub issue URL: $ISSUE_URL" >&2
    exit 2
fi

# Filter out comments from outside contributors (NONE, FIRST_TIMER) so the
# agent is not steered by untrusted input.
gh issue view "$ISSUE_URL" --json title,body,comments \
    --jq '.comments |= map(select(.authorAssociation != "NONE" and .authorAssociation != "FIRST_TIMER"))'
