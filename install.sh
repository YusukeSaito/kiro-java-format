#!/usr/bin/env bash
#
# Installs the `kiro-java-format` command so it is available from every
# terminal (and therefore every Kiro project/window), and installs a
# user-level Kiro steering file so the Kiro agent knows how to use it.
#
# Re-runnable (idempotent). No sudo required.
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

echo "kiro-java-format installer"
echo "  source: $SCRIPT_DIR"

# --- sanity checks ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not on PATH. Install Node.js 16+ first." >&2
  exit 1
fi

chmod +x "$SCRIPT_DIR/format-java.js" "$SCRIPT_DIR/bin/kiro-java-format"

# --- pick a bin dir that is already on PATH --------------------------------
choose_bindir() {
  local candidates=("$HOME/.local/bin" "/usr/local/bin")
  # also consider npm global bin
  if command -v npm >/dev/null 2>&1; then
    candidates+=("$(npm config get prefix 2>/dev/null)/bin")
  fi
  for d in "${candidates[@]}"; do
    case ":$PATH:" in
      *":$d:"*) echo "$d"; return 0 ;;
    esac
  done
  # nothing on PATH; default to ~/.local/bin and warn
  echo "$HOME/.local/bin"
  return 1
}

if BINDIR="$(choose_bindir)"; then
  ON_PATH=1
else
  ON_PATH=0
fi

mkdir -p "$BINDIR"
LINK="$BINDIR/kiro-java-format"
ln -sf "$SCRIPT_DIR/bin/kiro-java-format" "$LINK"
echo "  command: $LINK -> $SCRIPT_DIR/bin/kiro-java-format"

if [ "$ON_PATH" -eq 0 ]; then
  echo
  echo "WARNING: $BINDIR is not on your PATH."
  echo "  Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
  echo "    export PATH=\"$BINDIR:\$PATH\""
fi

# --- install user-level Kiro steering --------------------------------------
STEERING_DIR="$HOME/.kiro/steering"
mkdir -p "$STEERING_DIR"
cp "$SCRIPT_DIR/steering/java-formatter.md" "$STEERING_DIR/java-formatter.md"
echo "  steering: $STEERING_DIR/java-formatter.md"

echo
echo "Done. Try:  kiro-java-format --help"
