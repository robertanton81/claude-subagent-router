# Orchestrator plugin: save the rate limit values for the routing hook.
#
# Paste these lines into your status line script, after the place where it reads
# the rate limit fields. They expect these variables, all of them optional:
#   RATE_5H, RATE_7D              used_percentage of the 5-hour and the 7-day window
#   RATE_5H_RESET, RATE_7D_RESET  resets_at of each window, in Unix epoch seconds
#   SESSION_ID                    session_id
# A variable that is empty, not set or not a number is written as null.
#
# limits-latest.json  the newest values; the routing hook reads this file
# limits.jsonl        one line for every change; this is the measurement over time
#
# The block runs in a subshell and ends with "|| true". So a script that uses
# "set -e" still prints its status line when a write here fails.

if [[ -n "${RATE_5H:-}" || -n "${RATE_7D:-}" ]]; then
  (
    ORCH_DIR="$HOME/.claude/orchestrator"
    mkdir -p "$ORCH_DIR"
    # A number as it is, anything else as null, so the line stays valid JSON.
    # Leading zeros are not JSON, so a padded "05" becomes 5.
    orch_num() {
      local v="${1:-}"
      while [[ "$v" == 0[0-9]* ]]; do v="${v#0}"; done
      if [[ "$v" =~ ^[0-9]+([.][0-9]+)?$ ]]; then printf '%s' "$v"; else printf 'null'; fi
    }
    ORCH_SID=$(printf '%s' "${SESSION_ID:-}" | tr -cd 'A-Za-z0-9._-')
    if [[ -n "$ORCH_SID" ]]; then ORCH_SID_JSON="\"$ORCH_SID\""; else ORCH_SID_JSON=null; fi
    ORCH_LINE=$(printf '{"ts":%s,"five_hour":%s,"seven_day":%s,"five_hour_resets_at":%s,"seven_day_resets_at":%s,"session_id":%s}' \
      "$(date +%s)" "$(orch_num "${RATE_5H:-}")" "$(orch_num "${RATE_7D:-}")" \
      "$(orch_num "${RATE_5H_RESET:-}")" "$(orch_num "${RATE_7D_RESET:-}")" "$ORCH_SID_JSON")
    printf '%s\n' "$ORCH_LINE" > "$ORCH_DIR/limits-latest.json.tmp" && mv "$ORCH_DIR/limits-latest.json.tmp" "$ORCH_DIR/limits-latest.json"
    # A new window with the same percentage is a change too, so the reset times are part of the key.
    ORCH_VALUES="${RATE_5H:-} ${RATE_7D:-} ${RATE_5H_RESET:-} ${RATE_7D_RESET:-}"
    if [[ "$ORCH_VALUES" != "$(cat "$ORCH_DIR/limits-last-values.txt" 2>/dev/null)" ]]; then
      printf '%s\n' "$ORCH_LINE" >> "$ORCH_DIR/limits.jsonl"
      printf '%s' "$ORCH_VALUES" > "$ORCH_DIR/limits-last-values.txt"
    fi
  ) || true
fi
