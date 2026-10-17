#!/usr/bin/env bash
# A stand-in for the extension's nbcode launcher, for tests. Like nbexec.sh it
# runs the server as a child, kills it when this script ends, and exits with
# the server's exit code.
DIR="$(cd "$(dirname "$0")" && pwd)"
"${FAKE_NODE:-node}" "$DIR/../../fake-server.js" "$@" &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
wait $PID
