#!/bin/sh
# Runs the given command, restarting it on non-zero exit codes.
# Exits cleanly (without restarting) if the command exits with code 0.
# The delay between restarts can be configured via RESTART_DELAY_SECONDS (default: 5).
RESTART_DELAY_SECONDS=${RESTART_DELAY_SECONDS:-5}
while true; do
  "$@"
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    exit 0
  fi
  echo "Process exited with code $EXIT_CODE. Restarting in ${RESTART_DELAY_SECONDS} seconds..."
  sleep "$RESTART_DELAY_SECONDS"
done
