---
description: 分析 OpenCode 历史会话，生成完整 HTML Insight 报告（含 AGENTS.md 建议）
---

正在读取会话数据...

!`node --no-warnings ~/.config/opencode/insight-stats.mjs ${ARGUMENTS:-90} 2>&1`

---

以上是我最近 ${ARGUMENTS:-90} 天的 OpenCode 使用数据。请对这些数据进行深度分析，生成 Insight 报告。

**分析要求（全部使用中文，每项保持简洁）：**

1. **project_areas**：2段，描述用户主要工作类型和项目，第二人称。
2. **interaction_style**：2段，描述与 AI 的交互方式和工作流模式。
3. **what_works**：3个亮点，每个 title（5-8字）+ description（1-2句）。
4. **friction_analysis**：3个摩擦点，每个 title + symptom（1句）+ cause（1句）+ fix（1句）。
5. **agents_md_additions**：5条，从用户消息中提取反复出现的指令偏好，每条 addition（可直接粘贴到 AGENTS.md）+ why（20字）。
6. **features_to_try**：3个功能建议（MCP/Custom Commands/Plugins/Custom Agents/AGENTS.md），每条 title + why（20字）+ prompt（30字）。
7. **on_the_horizon**：2句展望。
8. **fun_ending**：headline（20字）+ detail（30字）。
9. **at_a_glance**：summary（2句）+ whats_working + whats_hindering + quick_wins + ambitious_workflows（各1句）。

**执行步骤（必须按顺序完成）：**

**第一步**：将分析结果整理为以下 JSON 结构，使用 Write 工具保存到 `~/.local/share/opencode/insights-analysis.json`：

```json
{
  "project_areas": "...",
  "interaction_style": "...",
  "what_works": [{"title": "...", "description": "..."}],
  "friction_analysis": [{"title": "...", "symptom": "...", "cause": "...", "fix": "..."}],
  "agents_md_additions": [{"addition": "...", "why": "..."}],
  "features_to_try": [{"title": "...", "why": "...", "prompt": "..."}],
  "on_the_horizon": "...",
  "fun_ending": {"headline": "...", "detail": "..."},
  "at_a_glance": {
    "summary": "...",
    "whats_working": "...",
    "whats_hindering": "...",
    "quick_wins": "...",
    "ambitious_workflows": "..."
  }
}
```

**第二步**：JSON 保存成功后，使用 Bash 工具执行以下命令生成 HTML 报告：

```bash
node --no-warnings ~/.config/opencode/insight-stats.mjs ${ARGUMENTS:-90} --render
```

**第三步**：告知用户报告已生成，提示运行 `open ~/.local/share/opencode/insight-report.html` 打开。
