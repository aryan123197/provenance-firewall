#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash `git commit` calls.
# Blocks --no-verify and runs the repo's pre-commit checks before Claude commits.
cmd=$(jq -r '.tool_input.command // empty')
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

if [[ "$cmd" == *--no-verify* || "$cmd" == *" git commit -n "* || "$cmd" =~ git[[:space:]]+commit([[:space:]]+[^|;&]*)?[[:space:]]-n([[:space:]]|$) ]]; then
  echo "Blocked: don't bypass pre-commit checks (--no-verify / -n). Fix the underlying issue instead." >&2
  exit 2
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
hook="$root/.githooks/pre-commit"
[ -x "$hook" ] || exit 0
out=$(cd "$root" && "$hook" 2>&1) || { echo "$out" >&2; exit 2; }
exit 0
