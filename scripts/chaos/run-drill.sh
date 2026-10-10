#!/usr/bin/env bash
# Runs all three scripts/chaos/*.sh scenarios back to back against an
# already-up docker-compose stack (including the `api` container itself —
# these scripts hit it over HTTP, unlike the e2e suite's in-process app),
# seeding its own throwaway credentials rather than requiring them to be
# passed in. Meant for unattended/scheduled use (see
# .github/workflows/chaos-drill.yml) where there's no human available to
# run scripts/chaos/README.md's manual seeding snippet first.
#
# Requires: `docker compose up -d --wait` already run for at least
# postgres-master, postgres-replica, pgbouncer-master, pgbouncer-replica,
# redis, vault, mock-psp, api. Writes one log file per scenario plus a
# summary.md into OUTPUT_DIR (default ./chaos-drill-output), and exits
# non-zero if any scenario failed — a real regression should fail this run
# loudly, not just leave a note in a log nobody reads.
set -uo pipefail

OUTPUT_DIR="${OUTPUT_DIR:-./chaos-drill-output}"
mkdir -p "$OUTPUT_DIR"

log() { echo "[run-drill] $*"; }

log "Seeding chaos-drill merchants inside the running api container..."
seed_output=$(cat "$(dirname "$0")/seed-chaos-merchants.js" | docker compose exec -T api node)
seed_exit=$?
if [ "$seed_exit" -ne 0 ]; then
  log "FAIL: seeding failed (exit $seed_exit):"
  echo "$seed_output"
  exit 1
fi
eval "$seed_output"

run_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git_sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
summary_file="$OUTPUT_DIR/summary.md"
{
  echo "# Chaos drill — $run_ts (commit $git_sha)"
  echo
} > "$summary_file"

overall_exit=0

run_scenario() {
  local name="$1"
  shift
  local log_file="$OUTPUT_DIR/${name}.log"
  log "Running $name..."
  if "$@" >"$log_file" 2>&1; then
    log "PASS: $name (full output: $log_file)"
    echo "- **PASS** \`$name\` — see \`${name}.log\`" >> "$summary_file"
  else
    log "FAIL: $name (full output: $log_file)"
    echo "- **FAIL** \`$name\` — see \`${name}.log\`" >> "$summary_file"
    overall_exit=1
  fi
}

script_dir="$(dirname "$0")"
run_scenario "psp-outage" bash "$script_dir/psp-outage.sh"
run_scenario "redis-outage" bash "$script_dir/redis-outage.sh"
run_scenario "postgres-primary-outage" bash "$script_dir/postgres-primary-outage.sh"

log "Summary written to $summary_file"
cat "$summary_file"

exit "$overall_exit"
