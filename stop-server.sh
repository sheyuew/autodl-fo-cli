#!/usr/bin/env bash
set -euo pipefail
# systemd's MainPID is dbus-run-session. Wait for its Node child to finish
# Browser.close before systemd signals the wrapper/process group.
fo_wrapper=${1:?Missing service MainPID}
fo_child=$(pgrep -P "$fo_wrapper" -x node || true)
if [ -z "$fo_child" ]; then exit 0; fi
kill -TERM "$fo_child" 2>/dev/null || exit 0
for ((fo_wait=0; fo_wait<200; fo_wait++)); do
  if ! kill -0 "$fo_child" 2>/dev/null; then exit 0; fi
  sleep 0.1
done
printf 'Chrome did not finish closing within 20 seconds.\n' >&2
exit 1
