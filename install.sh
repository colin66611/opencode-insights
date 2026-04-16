#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="$HOME/.config/opencode"
COMMANDS_DIR="$OPENCODE_DIR/commands"

echo "Installing OpenCode Insights..."

# Check Node.js version
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 22 ]; then
  echo "❌ Requires Node.js v22+. Current: $(node --version 2>/dev/null || echo 'not found')"
  echo "   Install via: brew install node  OR  https://nodejs.org"
  exit 1
fi

mkdir -p "$COMMANDS_DIR"

cp "$SCRIPT_DIR/insight-stats.mjs" "$OPENCODE_DIR/insight-stats.mjs"
cp "$SCRIPT_DIR/insights.md"       "$COMMANDS_DIR/insights.md"

echo ""
echo "✅ OpenCode Insights installed!"
echo ""
echo "👉 Next steps:"
echo "   1. Restart OpenCode (or reload)"
echo "   2. In the chat, type:  /insights"
echo "      Or specify days:    /insights 30"
echo ""
echo "   The HTML report will be saved to:"
echo "   ~/.local/share/opencode/insight-report.html"
echo ""
echo "   Run this to open it after generation:"
echo "   open ~/.local/share/opencode/insight-report.html"
