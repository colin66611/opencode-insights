# OpenCode Insights

Analyze your [OpenCode](https://opencode.ai) session history and generate an actionable HTML report — inspired by Claude Code's `/insights` feature.

## What You Get

- **At a Glance** — quick summary of your usage patterns
- **Usage Portrait** — how you actually use AI coding tools
- **Workflow Highlights** — 3 patterns working well for you
- **Friction Analysis** — 3 bottlenecks with root causes and fixes
- **AGENTS.md Recommendations** — personalized rules you can copy directly into your global `AGENTS.md`, with checkboxes and one-click copy
- **Features to Try** — OpenCode features suited to your patterns, with ready-to-paste prompts
- **Interactive Charts** — tool usage, file types, projects

## Requirements

- [OpenCode](https://opencode.ai) installed and used (has session history)
- Node.js v22+ (`node --version`)
- An AI provider configured in OpenCode (used automatically for LLM analysis)

## Install

```bash
curl -fsSL https://git.nevint.com/ds-odi/opencode-insights/-/raw/main/install.sh | bash
```

## Usage

Inside OpenCode:

```
/insights          # analyze last 90 days
/insights 30       # analyze last 30 days
/insights 180      # analyze last 180 days
```

The HTML report is saved to `~/.local/share/opencode/insight-report.html` and opened automatically.

## How It Works

1. Reads your local OpenCode SQLite database (`~/.local/share/opencode/opencode.db`) — **read-only, no data leaves your machine**
2. Extracts session stats: tool calls, file types, token usage, error rates, timelines
3. Calls your configured LLM provider (from `~/.config/opencode/opencode.json`) for qualitative analysis
4. Generates a self-contained HTML report
5. LLM results are cached for 12 hours to avoid redundant API calls

## Manual Install

```bash
mkdir -p ~/.config/opencode/commands

curl -fsSL https://git.nevint.com/ds-odi/opencode-insights/-/raw/main/insight-stats.mjs \
  -o ~/.config/opencode/insight-stats.mjs

curl -fsSL https://git.nevint.com/ds-odi/opencode-insights/-/raw/main/insights.md \
  -o ~/.config/opencode/commands/insights.md
```

## Privacy

All analysis runs locally. Your session data never leaves your machine. The only external call is to your own configured LLM provider (same as normal OpenCode usage).
