---
description: 分析 OpenCode 历史会话，生成完整 HTML Insight 报告（含 AGENTS.md 建议）
---
正在生成你的 OpenCode Insight 报告...

!`node --no-warnings ~/.config/opencode/insight-stats.mjs ${ARGUMENTS:-90} 2>&1 | grep -E "^(✅|⚠️|调用|使用缓存|LLM)"`

报告已生成，在终端运行以下命令打开：

```
open ~/.local/share/opencode/insight-report.html
```

报告包含：使用画像、工作流亮点、摩擦点分析、可直接复制到 AGENTS.md 的个性化规则，以及建议尝试的功能。
