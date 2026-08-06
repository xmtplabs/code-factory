#!/usr/bin/env bash
# check-pr.sh <pr-number|branch|url> [repo-dir]
#
# Deterministic PR status snapshot as greppable KEY=VALUE lines. This script
# only reports — all judgment (what to fix, when to sleep, when to give up)
# stays with the agent. Always exits 0 unless the PR itself can't be fetched.
#
# Output keys:
#   PR, URL, STATE, DRAFT, BRANCH, BASE, HEAD_SHA, MERGEABLE, MERGE_STATE
#   CI=PASS|FAIL|PENDING|NONE          (aggregated over the HEAD commit's checks)
#   REQUIRED_CI=PASS|FAIL|PENDING|NONE (required checks only)
#   FAILED_CHECKS_BEGIN … FAILED_CHECKS_END   (name<TAB>required|optional<TAB>link)
#   UNRESOLVED_THREADS=<n>
set -euo pipefail

pr="${1:?usage: check-pr.sh <pr-number|branch|url> [repo-dir]}"
dir="${2:-.}"
cd "$dir"

view=$(gh pr view "$pr" --json number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus)
num=$(jq -r .number <<<"$view")
echo "PR=$num"
echo "URL=$(jq -r .url <<<"$view")"
echo "STATE=$(jq -r .state <<<"$view")"
echo "DRAFT=$(jq -r .isDraft <<<"$view")"
echo "BRANCH=$(jq -r .headRefName <<<"$view")"
echo "BASE=$(jq -r .baseRefName <<<"$view")"
echo "HEAD_SHA=$(jq -r .headRefOid <<<"$view")"
echo "MERGEABLE=$(jq -r .mergeable <<<"$view")"
echo "MERGE_STATE=$(jq -r .mergeStateStatus <<<"$view")"

# gh pr checks uses nonzero exits to signal failing/pending checks — that is
# data here, not an error.
checks=$(gh pr checks "$num" --json name,state,bucket,link,required 2>/dev/null) || checks="[]"
[ -z "$checks" ] && checks="[]"

agg() { # agg '<jq filter for subset>'
  jq -r --arg f "$1" '
    [.[] | select($f == "all" or .required)] |
    if length == 0 then "NONE"
    elif any(.[]; .bucket == "fail" or .bucket == "cancel") then "FAIL"
    elif any(.[]; .bucket == "pending") then "PENDING"
    else "PASS" end' <<<"$checks"
}
echo "CI=$(agg all)"
echo "REQUIRED_CI=$(agg required)"

echo "FAILED_CHECKS_BEGIN"
jq -r '.[] | select(.bucket == "fail") | [.name, (if .required then "required" else "optional" end), (.link // "-")] | @tsv' <<<"$checks"
echo "FAILED_CHECKS_END"

repo=$(gh repo view --json owner,name --jq '.owner.login + " " + .name')
owner=${repo%% *}
name=${repo##* }
unresolved=$(gh api graphql \
  -f query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}' \
  -f owner="$owner" -f name="$name" -F pr="$num" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' 2>/dev/null) || unresolved="?"
echo "UNRESOLVED_THREADS=$unresolved"
