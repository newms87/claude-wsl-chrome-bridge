#!/bin/bash
# claude-chrome.sh - Run Claude Code with Chrome integration via WSL bridge
#
# This script:
# 1. Starts the WSL relay in the background (connects to Windows bridge)
# 2. Uses mount namespaces to hide WSL platform marker in /proc/version
# 3. Runs Claude Code with chrome integration enabled
#
# Prerequisites:
#   - Windows native-host must be running (started by Chrome or manually)
#   - Build the project first: npm run build
#
# Usage:
#   ./claude-chrome.sh [claude arguments...]
#
# Example:
#   ./claude-chrome.sh
#   ./claude-chrome.sh --model opus

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WSL_RELAY="$PROJECT_DIR/dist/wsl-relay.js"

# Check if wsl-relay exists
if [[ ! -f "$WSL_RELAY" ]]; then
    echo "ERROR: wsl-relay.js not found at $WSL_RELAY"
    echo "Please run 'npm run build' in $PROJECT_DIR first."
    exit 1
fi

# Create fake /proc/version that looks like native Linux (not WSL)
FAKE_PROC_VERSION="/tmp/fake_proc_version_$$"
echo "Linux version 6.6.87-generic (build@ubuntu) (gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38) #1 SMP PREEMPT_DYNAMIC $(date -u '+%c %Y')" > "$FAKE_PROC_VERSION"

# Track background processes for cleanup
WSL_RELAY_PID=""

cleanup() {
    rm -f "$FAKE_PROC_VERSION"
    if [[ -n "$WSL_RELAY_PID" ]] && kill -0 "$WSL_RELAY_PID" 2>/dev/null; then
        echo "[claude-chrome] Stopping WSL relay..."
        kill "$WSL_RELAY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# Log file for WSL relay
LOG_FILE="/tmp/claude-wsl-relay.log"

# Start WSL relay in the background, logging to file
echo "[claude-chrome] Starting WSL relay (logging to $LOG_FILE)..."
node "$WSL_RELAY" >> "$LOG_FILE" 2>&1 &
WSL_RELAY_PID=$!

# Give the relay a moment to connect
sleep 1

# Check if relay is still running
if ! kill -0 "$WSL_RELAY_PID" 2>/dev/null; then
    echo "ERROR: WSL relay failed to start. Check $LOG_FILE for details."
    echo ""
    echo "Make sure Chrome has spawned the native-host by clicking the Claude extension."
    tail -20 "$LOG_FILE" 2>/dev/null
    exit 1
fi

echo "[claude-chrome] WSL relay started (PID: $WSL_RELAY_PID)"
echo "[claude-chrome] Log file: $LOG_FILE"
echo "[claude-chrome] Starting Claude Code with Chrome integration..."
echo ""

# Run Claude in a mount namespace with the fake /proc/version
# The --user --map-root-user allows unprivileged users to create namespaces
unshare --user --map-root-user -m bash -c "
    mount --bind '$FAKE_PROC_VERSION' /proc/version

    # Set the environment variable to enable Chrome for Claude integration
    export CLAUDE_CODE_ENABLE_CFC=1

    # Run Claude Code
    exec claude \"\$@\"
" -- "$@"
