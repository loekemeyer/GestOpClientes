#!/bin/bash
# Toggle caveman mode on/off

MODE=$1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$MODE" ]; then
  echo "Usage: $0 on|off"
  exit 1
fi

case "$MODE" in
  on)
    ENABLED=true
    ;;
  off)
    ENABLED=false
    ;;
  *)
    echo "Invalid mode: $MODE. Use 'on' or 'off'"
    exit 1
    ;;
esac

# Update config-claude.json
if [ -f "$REPO_ROOT/config-claude.json" ]; then
  jq ".caveman = $ENABLED" "$REPO_ROOT/config-claude.json" > /tmp/config-tmp.json && mv /tmp/config-tmp.json "$REPO_ROOT/config-claude.json"
fi

# Update caveman-state.json
if [ -f "$REPO_ROOT/caveman-state.json" ]; then
  jq ".caveman = $ENABLED" "$REPO_ROOT/caveman-state.json" > /tmp/state-tmp.json && mv /tmp/state-tmp.json "$REPO_ROOT/caveman-state.json"
fi

echo "Caveman mode: $([ "$ENABLED" = "true" ] && echo "ON" || echo "OFF")"
