#!/usr/bin/env bash
# Record a replay fixture for the terminal engine (src/term/__tests__/fixtures/).
#
# Runs a command inside a detached 80x24 tmux session, captures the raw byte
# stream the application writes (tmux pipe-pane) and the screen tmux itself
# ends up with (tmux capture-pane) as the expected result. The replay test
# feeds the bytes through our engine and asserts the same final screen.
#
# Usage:
#   scripts/record-fixture.sh <name> <command> [key ...]
#
# Each `key` is a tmux send-keys argument sent after the app settles
# (use e.g. 'q' 'Enter'; a literal SLEEP token pauses instead of sending).
#
# Example:
#   scripts/record-fixture.sh less-scroll 'less /etc/services' PageDown PageDown SLEEP

set -euo pipefail

name=$1
command=$2
shift 2

dir="$(cd "$(dirname "$0")/.." && pwd)/src/term/__tests__/fixtures"
mkdir -p "$dir"
session="fixture-$name-$$"
raw="$dir/$name.bin"
expected="$dir/$name.txt"

rm -f "$raw" "$expected"

# The pane command waits until pipe-pane is attached (the marker file
# appears), so the recording contains every byte the app produces.
marker=$(mktemp -u)
tmux -f /dev/null new-session -d -s "$session" -x 80 -y 24 \
  "while [ ! -e '$marker' ]; do sleep 0.05; done; $command"
tmux pipe-pane -t "$session" -o "cat >> '$raw'"
touch "$marker"

sleep 2
for key in "$@"; do
  if [ "$key" = SLEEP ]; then
    sleep 1
  else
    tmux send-keys -t "$session" "$key"
    sleep 0.4
  fi
done
sleep 1

# Stop recording before capturing so no bytes arrive after the snapshot.
tmux pipe-pane -t "$session"
sleep 0.2
tmux capture-pane -t "$session" -p > "$expected"
tmux kill-session -t "$session"
rm -f "$marker"

echo "recorded $name: $(wc -c < "$raw") bytes, expected screen in $expected"
