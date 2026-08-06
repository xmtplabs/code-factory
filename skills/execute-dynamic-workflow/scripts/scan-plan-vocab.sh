#!/usr/bin/env bash
# scan-plan-vocab.sh <repo-root> <base-ref> [extra-pattern]
#
# Deterministic backstop for the no-plan-vocabulary rule: greps the diff
# against <base-ref> for spec/planning markers that must never reach final
# code — requirement ids, phase/task references, plan language. Exits 0 when
# clean, 1 with the offending lines when not. Run at every phase boundary;
# a phase cannot close while this is red.
#
# [extra-pattern] is an optional extended-regex for the spec's own id scheme
# (e.g. 'PROJ-[0-9]+'), OR-ed into the built-in patterns.
set -euo pipefail

repo="${1:?usage: scan-plan-vocab.sh <repo-root> <base-ref> [extra-pattern]}"
base="${2:?usage: scan-plan-vocab.sh <repo-root> <base-ref> [extra-pattern]}"
extra="${3:-}"

# Built-in markers. Word-boundaried to keep noise down; tune per repo if a
# legitimate domain term collides (then pass a tighter extra-pattern instead).
pattern='\bEARS[- ]?[0-9]+\b|\bREQ-[0-9]+\b|\brequirement[- ](id|ids)\b|\bsatisf(y|ies|ying) (the )?requirement\b|\bPhase [0-9]+\b|\bTask [0-9]+(\.[0-9]+)?\b|\bper the (plan|spec)\b|\bCONTINUE[- ]TO\b|\bacceptance criteri(a|on)\b'
if [ -n "$extra" ]; then
  pattern="$pattern|$extra"
fi

# Diff of tracked changes only; plan directories themselves are allowed to
# contain plan vocabulary, so exclude docs/plans and this skill's own files.
hits=$(git -C "$repo" diff "$base" -- . ':(exclude)docs/plans/**' ':(exclude)**/scan-plan-vocab.sh' \
  | grep -E '^\+' | grep -Ev '^\+\+\+' | grep -Ei "$pattern" || true)

if [ -n "$hits" ]; then
  echo "PLAN VOCABULARY FOUND in diff vs $base — strip these before the phase can close:"
  echo "$hits"
  exit 1
fi
echo "clean"
