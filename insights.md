---
description: 分析 OpenCode 历史会话，生成完整 HTML Insight 报告（含 AGENTS.md 建议）
---

正在读取会话数据...

!`node --no-warnings ~/.config/opencode/insight-stats.mjs ${ARGUMENTS:-90} 2>&1`

---

以上是我最近 ${ARGUMENTS:-90} 天的 OpenCode 使用数据。请对这些数据进行深度分析，生成 Insight 报告。

**分析要求（全部使用中文）：**

1. **project_areas**（使用画像-项目方向）：2-3段，描述用户主要做什么类型的工作，专注于哪些项目，用第二人称（"你..."）。

2. **interaction_style**（使用画像-交互风格）：2-3段，描述用户与 AI 的交互方式、工作流模式。

3. **what_works**（工作流亮点）：3个正向模式，每个包含 title（5-10字）和 description（2-3句具体描述）。

4. **friction_analysis**（摩擦点）：3个阻碍效率的问题，每个包含：
   - title（5-10字）
   - symptom（表现，1句）
   - cause（根因，1句）
   - fix（具体可执行的改进方案，1-2句）

5. **agents_md_additions**（AGENTS.md 建议）：5-7条，**重点**：从"用户消息摘要"中提取用户反复给 AI 的指令（如语言偏好、代码风格要求、工作方式约定等），这些是最有价值的内容。每条包含：
   - addition（直接可粘贴到 AGENTS.md 的内容，markdown 格式）
   - why（30字以内，说明为何有用）

6. **features_to_try**（建议功能）：3个 OpenCode 功能建议，基于以下参考：
   - **MCP Servers**：在 opencode.json 的 mcp 字段配置外部工具
   - **Custom Commands**：在 ~/.config/opencode/commands/ 放 .md 文件，/命令名触发
   - **Plugins**：在 ~/.config/opencode/plugins/ 放 .ts 文件注册自定义工具
   - **Custom Agents**：在 opencode.json 的 agent 字段定义专用 agent
   - **AGENTS.md**：项目根目录放 AGENTS.md，每次对话自动注入
   
   每条包含：title（5-10字）、why（40字以内）、prompt（可直接粘贴到 OpenCode 的提示词，50字以内）

7. **on_the_horizon**（展望）：2-3句，描述用户还没充分探索的机会或潜力，前瞻性语气。

8. **fun_ending**（结尾）：从会话数据中找一个有趣/值得记录的亮点，包含 headline（30字以内）和 detail（50字以内）。

9. **at_a_glance**（总结，最后生成）：基于以上所有分析，生成：
   - summary（2-3句整体总结）
   - whats_working（1句，什么在发挥作用）
   - whats_hindering（1句，最大阻碍）
   - quick_wins（1句，最值得立即改进的）
   - ambitious_workflows（1句，可以更进一步的方向）

**请将分析结果输出为严格的 JSON，然后使用 Write 工具将 JSON 保存到 `~/.local/share/opencode/insights-analysis.json`**

JSON 结构：
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

保存完 JSON 后，运行以下命令生成 HTML 报告：

!`node --no-warnings ~/.config/opencode/insight-stats.mjs ${ARGUMENTS:-90} --render 2>&1`

报告已生成！在终端运行以下命令打开：

```
open ~/.local/share/opencode/insight-report.html
```
