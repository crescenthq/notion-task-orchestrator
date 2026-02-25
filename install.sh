#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIRS=(
  "${HOME}/.openclaw/skills/notionflow-setup"
  "${HOME}/.claude/skills/notionflow-setup"
  "${HOME}/.agents/skills/notionflow-setup"
)

echo "==> Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent

echo "==> Initializing ~/.config/notionflow/..."
npx tsx src/notionflow.ts init

echo "==> Installing bundled agents..."
for agent in "$SCRIPT_DIR"/agents/*; do
  [ -f "$agent" ] && npx tsx src/notionflow.ts agent install "$agent"
done

echo "==> Installing bundled workflows..."
for wf in "$SCRIPT_DIR"/workflows/*.yaml; do
  if [ -f "$wf" ]; then
    cp "$wf" "${HOME}/.config/notionflow/workflows/"
    echo "  Copied $(basename "$wf")"
  fi
done

echo "==> Installing setup skill..."
for dir in "${SKILL_DIRS[@]}"; do
  mkdir -p "$dir"
  cp "$SCRIPT_DIR/.claude/skills/setup/SKILL.md" "$dir/SKILL.md"
  echo "  Installed to $dir"
done

echo ""
echo "NotionFlow installed to ~/.config/notionflow/"
echo "Setup skill installed to: ${SKILL_DIRS[*]}"
echo ""
echo "Next: use /notionflow-setup in your prefered agent (Openclaw, Claude Code, Codex, Opencode, Amp) to configure your Notion API key and create your first board."
