#!/usr/bin/env bash
set -euo pipefail

revision=${1:-$(git rev-parse HEAD)}
repository=${2:-}
poll_seconds=${AMCDR_CI_POLL_SECONDS:-15}
timeout_seconds=${AMCDR_CI_TIMEOUT_SECONDS:-7200}
discovery_timeout_seconds=${AMCDR_CI_DISCOVERY_TIMEOUT_SECONDS:-300}
settle_seconds=${AMCDR_CI_SETTLE_SECONDS:-30}
failure_grace_seconds=${AMCDR_CI_FAILURE_GRACE_SECONDS:-90}

case "$revision" in
  (*[!0-9a-f]*|'') echo "Revision must be a lowercase Git SHA." >&2; exit 2 ;;
esac
if (( ${#revision} != 40 )); then
  echo "Revision must be a complete 40-character Git SHA." >&2
  exit 2
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required to monitor Actions." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to monitor Actions." >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login -h github.com" >&2
  exit 2
fi
if [[ -z "$repository" ]]; then
  repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

started_at=$(date +%s)
discovery_deadline=$((started_at + discovery_timeout_seconds))
deadline=$((started_at + timeout_seconds))
last_snapshot=""
success_since=0
successful_run_ids=""
failure_since=0

echo "Watching GitHub Actions for $repository@$revision"
while :; do
  now=$(date +%s)
  if (( now >= deadline )); then
    echo "Timed out waiting for GitHub Actions after ${timeout_seconds}s." >&2
    exit 124
  fi

  runs=$(gh run list \
    --repo "$repository" \
    --commit "$revision" \
    --limit 100 \
    --json databaseId,name,status,conclusion,url,createdAt)
  run_count=$(jq 'length' <<<"$runs")
  if (( run_count == 0 )); then
    if (( now >= discovery_deadline )); then
      echo "No GitHub Actions runs appeared within ${discovery_timeout_seconds}s." >&2
      exit 1
    fi
    sleep "$poll_seconds"
    continue
  fi

  snapshot=$(jq -r \
    'sort_by(.createdAt)[] | "\(.name): \(.status)\(if .conclusion != "" then " (" + .conclusion + ")" else "" end)"' \
    <<<"$runs")
  if [[ "$snapshot" != "$last_snapshot" ]]; then
    printf '%s\n' "$snapshot"
    last_snapshot=$snapshot
  fi

  failed_runs=$(jq -r \
    '.[] | select(.status == "completed") | select(.conclusion | IN("success", "neutral", "skipped") | not) | .databaseId' \
    <<<"$runs")
  if [[ -n "$failed_runs" ]]; then
    success_since=0
    successful_run_ids=""
    if (( failure_since == 0 )); then
      failure_since=$now
      echo "A workflow failed; waiting up to ${failure_grace_seconds}s for the bounded automatic retry."
    fi
    if (( now - failure_since < failure_grace_seconds )); then
      sleep "$poll_seconds"
      continue
    fi
    while IFS= read -r run_id; do
      [[ -n "$run_id" ]] || continue
      echo "Failed workflow logs for run $run_id:" >&2
      gh run view "$run_id" --repo "$repository" --log-failed >&2 || true
    done <<<"$failed_runs"
    exit 1
  fi
  failure_since=0

  incomplete_count=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
  unsuccessful_count=$(jq \
    '[.[] | select(.status == "completed") | select(.conclusion | IN("success", "neutral", "skipped") | not)] | length' \
    <<<"$runs")
  if (( incomplete_count == 0 && unsuccessful_count == 0 )); then
    current_run_ids=$(jq -r 'sort_by(.databaseId) | map(.databaseId | tostring) | join(",")' <<<"$runs")
    if (( success_since == 0 )) || [[ "$successful_run_ids" != "$current_run_ids" ]]; then
      success_since=$now
      successful_run_ids=$current_run_ids
      echo "All current runs passed; waiting ${settle_seconds}s for downstream workflows."
    elif (( now - success_since >= settle_seconds )); then
      echo "All GitHub Actions runs succeeded for $revision."
      exit 0
    fi
  else
    success_since=0
    successful_run_ids=""
  fi

  sleep "$poll_seconds"
done
