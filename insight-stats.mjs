#!/usr/bin/env node
/**
 * OpenCode Insight – Full Report Generator
 * 1. 读 SQLite 提取统计数据
 * 2. 调 LLM 生成结构化 JSON 分析
 * 3. 输出亮色主题 HTML 报告（对标 Claude Code insights 设计）
 */
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileSync, readFileSync, existsSync } from "node:fs"

// ─── Config ──────────────────────────────────────────────────────────────────
const DAYS = parseInt(process.argv[2] ?? "90")
const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db")
const REPORT_PATH = join(homedir(), ".local/share/opencode/insight-report.html")
const CACHE_PATH = join(homedir(), ".local/share/opencode/insights-cache.json")
const CONFIG_PATH = join(homedir(), ".config/opencode/opencode.json")
const SINCE = Date.now() - DAYS * 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12 小时缓存

// ─── 读取 OpenCode 配置，找 LLM API 信息 ─────────────────────────────────────
function loadApiConfig() {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    const disabled = new Set(cfg.disabled_providers ?? [])

    // 优先找 Anthropic 兼容 API（有 baseURL + apiKey）
    for (const [id, provider] of Object.entries(cfg.provider ?? {})) {
      if (disabled.has(id)) continue
      const opts = provider.options ?? {}
      if (opts.apiKey && opts.baseURL) {
        const models = Object.keys(provider.models ?? {})
        // 挑能力较强的模型
        const preferred = ["kimi-k2.5", "qwen3-coder-plus", "qwen3.5-plus", "qwen3-max", "glm-5", "glm-4.7"]
        const model = preferred.find((m) => models.includes(m)) ?? models[0]
        if (model) {
          return { baseURL: opts.baseURL, apiKey: opts.apiKey, model, provider: id }
        }
      }
    }
  } catch (_) {}
  return null
}

// ─── Database ────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH, { open: true })

const sessions = db
  .prepare(
    `SELECT id, title, directory, time_created, time_updated,
            summary_additions, summary_deletions, summary_files
     FROM session
     WHERE time_archived IS NULL AND time_created >= ?
     ORDER BY time_updated DESC`
  )
  .all(SINCE)

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getFileExt(filePath) {
  const filename = filePath.split("/").pop() ?? ""
  const dotIdx = filename.lastIndexOf(".")
  if (dotIdx <= 0) return null
  const ext = filename.slice(dotIdx).toLowerCase()
  return ext.length <= 6 ? ext : null
}

function extractFileExt(input) {
  const path = input?.filePath ?? input?.path ?? input?.file_path ?? null
  return typeof path === "string" ? getFileExt(path) : null
}

function cleanUserMessage(text) {
  return text
    .replace(/^\[[\w-]+\][\s\S]*?---\n\n/m, "")
    .replace(/\[图片\]/g, "")
    .trim()
    .slice(0, 200)
    .replace(/\n/g, " ")
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ─── Per-Session Analysis ─────────────────────────────────────────────────────
function analyzeSession(session) {
  const messages = db
    .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`)
    .all(session.id)

  const parts = db
    .prepare(`SELECT data, message_id FROM part WHERE session_id = ? ORDER BY time_created ASC`)
    .all(session.id)

  let userMsgs = 0, assistantMsgs = 0, tokensIn = 0, tokensOut = 0, cost = 0
  let minTime = Infinity, maxTime = 0
  const models = new Set()
  const msgMap = new Map()

  for (const msg of messages) {
    const d = JSON.parse(msg.data)
    msgMap.set(msg.id, { role: d.role })
    if (d.role === "user") userMsgs++
    else if (d.role === "assistant") {
      assistantMsgs++
      if (d.modelID) models.add(d.modelID)
    }
    if (msg.time_created < minTime) minTime = msg.time_created
    if (msg.time_created > maxTime) maxTime = msg.time_created
  }

  const tools = {}, fileExts = {}
  let errors = 0, firstUserMessage = ""

  for (const part of parts) {
    const d = JSON.parse(part.data)
    if (d.type === "step-finish") {
      if (d.cost) cost += d.cost
      if (d.tokens) { tokensIn += d.tokens.input ?? 0; tokensOut += d.tokens.output ?? 0 }
    }
    if (d.type === "tool") {
      const t = d.tool ?? "unknown"
      tools[t] = (tools[t] ?? 0) + 1
      if (d.state?.status === "error") errors++
      const ext = d.state?.input ? extractFileExt(d.state.input) : null
      if (ext) fileExts[ext] = (fileExts[ext] ?? 0) + 1
    }
    if (d.type === "text" && !firstUserMessage && typeof d.text === "string") {
      const info = msgMap.get(part.message_id)
      if (info?.role === "user") firstUserMessage = cleanUserMessage(d.text)
    }
  }

  return {
    id: session.id,
    title: session.title,
    project: session.directory.split("/").slice(-2).join("/"),
    date: new Date(session.time_created).toLocaleDateString("zh-CN"),
    durationMin: minTime !== Infinity && maxTime > minTime ? Math.round((maxTime - minTime) / 60000) : 0,
    userMsgs, assistantMsgs, tokensIn, tokensOut, cost,
    linesAdded: session.summary_additions ?? 0,
    linesDeleted: session.summary_deletions ?? 0,
    tools, fileExts, errors, firstUserMessage,
    models: [...models],
  }
}

// ─── Aggregate ───────────────────────────────────────────────────────────────
process.stderr.write(`分析最近 ${DAYS} 天的 ${sessions.length} 个会话...\n`)
const summaries = sessions.map(analyzeSession)

const totalTokens = summaries.reduce((s, x) => s + x.tokensIn + x.tokensOut, 0)
const totalCost = summaries.reduce((s, x) => s + x.cost, 0)
const totalLinesAdded = summaries.reduce((s, x) => s + x.linesAdded, 0)
const totalLinesDeleted = summaries.reduce((s, x) => s + x.linesDeleted, 0)
const totalUserMsgs = summaries.reduce((s, x) => s + x.userMsgs, 0)
const totalErrors = summaries.reduce((s, x) => s + x.errors, 0)
const totalToolCalls = summaries.reduce((s, x) => s + Object.values(x.tools).reduce((a, b) => a + b, 0), 0)

const allTools = {}
for (const s of summaries) for (const [t, n] of Object.entries(s.tools)) allTools[t] = (allTools[t] ?? 0) + n
const topTools = Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 12)

const allExts = {}
for (const s of summaries) for (const [e, n] of Object.entries(s.fileExts)) allExts[e] = (allExts[e] ?? 0) + n
const topExts = Object.entries(allExts).sort((a, b) => b[1] - a[1]).slice(0, 10)

const projectMap = {}
for (const s of summaries) {
  const p = projectMap[s.project] ?? { msgs: 0, sessions: 0 }
  p.msgs += s.userMsgs; p.sessions++
  projectMap[s.project] = p
}
const topProjects = Object.entries(projectMap).sort((a, b) => b[1].sessions - a[1].sessions).slice(0, 8)

const allModels = new Set(summaries.flatMap((s) => s.models))
const activeDays = new Set(summaries.map((s) => s.date)).size
const avgDuration = summaries.length > 0
  ? Math.round(summaries.reduce((s, x) => s + x.durationMin, 0) / summaries.length) : 0

const hourMap = {}
for (const s of sessions) { const h = new Date(s.time_created).getHours(); hourMap[h] = (hourMap[h] ?? 0) + 1 }
const peakHour = Object.entries(hourMap).sort((a, b) => Number(b[1]) - Number(a[1]))[0]

// ─── 格式化统计文本（stdout → command template 使用）────────────────────────
const statsText = `
# OpenCode 使用数据（最近 ${DAYS} 天）

## 总体概况
- 分析时间范围：${new Date(SINCE).toLocaleDateString("zh-CN")} 至 ${new Date().toLocaleDateString("zh-CN")}
- 总会话数：${summaries.length} 个，活跃 ${activeDays} 天（平均 ${(summaries.length / Math.max(activeDays, 1)).toFixed(1)} 个/天）
- 总用户消息：${totalUserMsgs} 条
- 总工具调用：${totalToolCalls} 次（错误 ${totalErrors} 次，错误率 ${totalToolCalls > 0 ? ((totalErrors / totalToolCalls) * 100).toFixed(1) : 0}%）
- 总 Token：${(totalTokens / 1000).toFixed(0)}K | 总费用：$${totalCost.toFixed(4)}
- 代码净变更：+${totalLinesAdded} / -${totalLinesDeleted} 行
- 平均会话时长：${avgDuration} 分钟 | 高峰时段：${peakHour ? peakHour[0] + ":00" : "未知"}

## AI 模型
${[...allModels].join(", ") || "未记录"}

## 主要项目（按会话数）
${topProjects.map(([p, d], i) => `${i + 1}. ${p}（${d.sessions}个会话，${d.msgs}条消息）`).join("\n")}

## 工具频率（Top 12）
${topTools.map(([t, n]) => `- ${t}: ${n}次`).join("\n")}

## 文件类型（Top 10）
${topExts.map(([e, n]) => `- ${e}: ${n}次`).join("\n")}

## 各会话（最近 ${Math.min(summaries.length, 50)} 个）
${summaries.slice(0, 50).map((s) =>
  `### [${s.date}] ${s.title}
- 项目：${s.project} | 时长：${s.durationMin}分钟 | 消息：${s.userMsgs}条
- 工具：${Object.entries(s.tools).map(([t, n]) => `${t}(${n})`).join(", ") || "无"}${s.errors > 0 ? ` | ⚠️ 错误：${s.errors}次` : ""}
- 代码：+${s.linesAdded}/-${s.linesDeleted}行
${s.firstUserMessage ? `- 问题：${s.firstUserMessage}` : ""}`
).join("\n\n")}
`.trim()

process.stdout.write(statsText + "\n")

// ─── LLM 分析 ─────────────────────────────────────────────────────────────────
async function callLLM(statsText) {
  // 先检查缓存
  if (existsSync(CACHE_PATH)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"))
      if (cache.ts && Date.now() - cache.ts < CACHE_TTL_MS && cache.days === DAYS) {
        process.stderr.write("使用缓存的分析结果（12小时内）\n")
        return cache.data
      }
    } catch (_) {}
  }

  const apiCfg = loadApiConfig()
  if (!apiCfg) {
    process.stderr.write("未找到可用的 API 配置，跳过 LLM 分析\n")
    return null
  }

  process.stderr.write(`调用 ${apiCfg.provider}/${apiCfg.model} 生成洞察分析...\n`)

  const prompt = `你是一个专业的AI工具使用分析师。以下是用户使用OpenCode（AI编程助手工具）的完整使用数据。

请深入分析这些数据，以**严格的 JSON 格式**返回结果（只返回 JSON，不要 markdown 代码块，不要任何其他文字）。

JSON 结构：
{
  "at_a_glance": {
    "summary": "2-3句总结该用户的整体使用模式",
    "whats_working": "什么工作模式效果好（具体，1-2句）",
    "whats_hindering": "什么在阻碍效率（具体，1-2句）",
    "quick_wins": "立即可以改进的地方（1-2句）"
  },
  "usage_portrait": "200字左右，描述用户的工作方式、主要项目类型、解决的问题类型、AI使用习惯",
  "highlights": [
    {"title": "亮点名称（5-8字）", "description": "120字左右，描述这个优秀工作模式及为什么有效，并说明如何进一步强化"}
  ],
  "friction": [
    {"title": "摩擦点名称（5-8字）", "symptom": "表现：具体说明", "cause": "根因：具体说明", "fix": "改进方案：具体可执行的步骤"}
  ],
  "agents_md_additions": [
    {
      "addition": "直接粘贴到AGENTS.md的内容（markdown格式，具体的规则或偏好声明，1-3行，不要废话）",
      "why": "这条规则能改善AI助手行为的原因（30字以内）"
    }
  ],
  "features_to_try": [
    {
      "title": "功能名称（5-8字）",
      "why": "为什么适合该用户（基于数据的判断，40字以内）",
      "prompt": "可以直接粘贴到OpenCode聊天框的提示词，让AI帮助设置或演示这个功能（50字以内）"
    }
  ],
  "fun_moment": {
    "headline": "从会话历史中选出一个有趣/值得记录的时刻（引用形式，20字以内）",
    "detail": "补充说明（30字以内）"
  }
}

要求：
- highlights：3个
- friction：3个
- agents_md_additions：5-7个，内容要非常具体、直接可用，基于真实数据
- features_to_try：3个
- 全部使用中文
- 严格 JSON 格式，不允许有任何 JSON 之外的内容

===用户数据===
${statsText}`

  try {
    const url = `${apiCfg.baseURL.replace(/\/$/, "")}/messages`
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiCfg.apiKey,
        "Authorization": `Bearer ${apiCfg.apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: apiCfg.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    })

    if (!resp.ok) {
      const err = await resp.text()
      process.stderr.write(`LLM API 错误 ${resp.status}: ${err.slice(0, 200)}\n`)
      return null
    }

    const json = await resp.json()
    // content 是数组，可能含 thinking 块，找第一个 type==="text" 的
    const textBlock = Array.isArray(json.content)
      ? json.content.find((b) => b.type === "text")
      : null
    const rawText = textBlock?.text ?? json.choices?.[0]?.message?.content ?? ""

    // 解析 JSON（模型可能加了代码块）
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      process.stderr.write("LLM 未返回有效 JSON\n")
      return null
    }

    const data = JSON.parse(jsonMatch[0])
    // 保存缓存
    writeFileSync(CACHE_PATH, JSON.stringify({ ts: Date.now(), days: DAYS, data }))
    return data
  } catch (e) {
    process.stderr.write(`LLM 调用失败: ${e.message}\n`)
    return null
  }
}

// ─── HTML 报告生成 ─────────────────────────────────────────────────────────────
function markdownToHtml(md) {
  if (!md) return ""
  return md.split("\n\n").map((p) => {
    let h = escHtml(p)
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    h = h.replace(/^- /gm, "• ")
    h = h.replace(/\n/g, "<br>")
    return `<p>${h}</p>`
  }).join("\n")
}

function barRow(label, value, max, color = "#6366f1") {
  const w = Math.round((value / Math.max(max, 1)) * 100)
  return `
  <div class="bar-row">
    <div class="bar-label">${escHtml(label)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>
    <div class="bar-value">${value}</div>
  </div>`
}

function generateHtml(llmData) {
  // ── At a Glance ──
  const ag = llmData?.at_a_glance
  const atAGlanceHtml = ag ? `
  <div class="at-a-glance">
    <div class="glance-title">At a Glance</div>
    <div class="glance-sections">
      ${ag.summary ? `<div class="glance-section">${escHtml(ag.summary)}</div>` : ""}
      ${ag.whats_working ? `<div class="glance-section"><strong>✅ 什么在发挥作用：</strong>${escHtml(ag.whats_working)} <a href="#section-highlights" class="see-more">工作流亮点 →</a></div>` : ""}
      ${ag.whats_hindering ? `<div class="glance-section"><strong>⚠️ 什么在阻碍你：</strong>${escHtml(ag.whats_hindering)} <a href="#section-friction" class="see-more">摩擦点分析 →</a></div>` : ""}
      ${ag.quick_wins ? `<div class="glance-section"><strong>⚡ 立即可以改进：</strong>${escHtml(ag.quick_wins)} <a href="#section-agents" class="see-more">AGENTS.md 建议 →</a></div>` : ""}
    </div>
  </div>` : ""

  // ── Stats Row ──
  const statsRowHtml = `
  <div class="stats-row">
    <div class="stat"><div class="stat-value">${summaries.length}</div><div class="stat-label">Sessions</div></div>
    <div class="stat"><div class="stat-value">${activeDays}</div><div class="stat-label">Active Days</div></div>
    <div class="stat"><div class="stat-value">${totalUserMsgs}</div><div class="stat-label">Messages</div></div>
    <div class="stat"><div class="stat-value">${totalToolCalls}</div><div class="stat-label">Tool Calls</div></div>
    <div class="stat"><div class="stat-value">${(totalTokens / 1000).toFixed(0)}K</div><div class="stat-label">Tokens</div></div>
    <div class="stat"><div class="stat-value" style="color:#22c55e">+${totalLinesAdded}</div><div class="stat-label">Lines Added</div></div>
    <div class="stat"><div class="stat-value" style="color:#ef4444">-${totalLinesDeleted}</div><div class="stat-label">Lines Deleted</div></div>
    <div class="stat"><div class="stat-value">${avgDuration}m</div><div class="stat-label">Avg Session</div></div>
  </div>`

  // ── Usage Portrait ──
  const portraitHtml = llmData?.usage_portrait ? `
  <h2 id="section-portrait">使用画像</h2>
  <div class="narrative">${markdownToHtml(llmData.usage_portrait)}</div>` : ""

  // ── Charts ──
  const chartsHtml = `
  <div class="charts-row">
    <div class="chart-card">
      <div class="chart-title">工具使用频率</div>
      ${topTools.map(([t, n]) => barRow(t, n, topTools[0]?.[1] ?? 1, "#6366f1")).join("")}
    </div>
    <div class="chart-card">
      <div class="chart-title">文件类型分布</div>
      ${topExts.length > 0
        ? topExts.map(([e, n]) => barRow(e, n, topExts[0]?.[1] ?? 1, "#8b5cf6")).join("")
        : '<span class="empty">暂无数据</span>'}
    </div>
  </div>
  <div class="charts-row">
    <div class="chart-card">
      <div class="chart-title">主要项目</div>
      ${topProjects.map(([p, d]) => barRow(p, d.sessions, topProjects[0]?.[1]?.sessions ?? 1, "#06b6d4")).join("")}
    </div>
    <div class="chart-card">
      <div class="chart-title">使用模型</div>
      ${[...allModels].map((m) => `<div style="font-size:12px;color:#475569;padding:4px 0;border-bottom:1px solid #f1f5f9">${escHtml(m)}</div>`).join("") || '<span class="empty">未记录</span>'}
    </div>
  </div>`

  // ── Highlights ──
  const hlData = llmData?.highlights ?? []
  const highlightsHtml = hlData.length > 0 ? `
  <h2 id="section-highlights">工作流亮点</h2>
  <div class="big-wins">
    ${hlData.map((h) => `
    <div class="big-win">
      <div class="big-win-title">${escHtml(h.title ?? "")}</div>
      <div class="big-win-desc">${escHtml(h.description ?? "")}</div>
    </div>`).join("")}
  </div>` : ""

  // ── Friction ──
  const frData = llmData?.friction ?? []
  const frictionHtml = frData.length > 0 ? `
  <h2 id="section-friction">摩擦点分析</h2>
  <div class="friction-categories">
    ${frData.map((f) => `
    <div class="friction-category">
      <div class="friction-title">${escHtml(f.title ?? "")}</div>
      ${f.symptom ? `<div class="friction-meta"><strong>表现：</strong>${escHtml(f.symptom)}</div>` : ""}
      ${f.cause ? `<div class="friction-meta"><strong>根因：</strong>${escHtml(f.cause)}</div>` : ""}
      ${f.fix ? `<div class="friction-fix">💡 ${escHtml(f.fix)}</div>` : ""}
    </div>`).join("")}
  </div>` : ""

  // ── AGENTS.md Additions（核心：checkbox + copy） ──
  const agMdData = llmData?.agents_md_additions ?? []
  const agentsMdHtml = agMdData.length > 0 ? `
  <h2 id="section-agents">AGENTS.md 推荐内容</h2>
  <div class="claude-md-section">
    <h3>基于你的使用模式生成的个性化规则</h3>
    <p style="font-size:12px;color:#64748b;margin-bottom:12px">勾选需要的条目后点击「Copy All Checked」，直接粘贴到 <code>~/.config/opencode/AGENTS.md</code></p>
    <div class="claude-md-actions">
      <button class="copy-all-btn" onclick="copyAllChecked()">Copy All Checked</button>
    </div>
    ${agMdData.map((item, i) => `
    <div class="claude-md-item">
      <input type="checkbox" id="agmd-${i}" class="agmd-checkbox" checked data-text="${escHtml(item.addition ?? "")}">
      <label for="agmd-${i}">
        <code class="cmd-code">${escHtml(item.addition ?? "")}</code>
        <button class="copy-btn" onclick="copySingle(${i})">Copy</button>
      </label>
      <div class="cmd-why">${escHtml(item.why ?? "")}</div>
    </div>`).join("")}
  </div>` : ""

  // ── Features to Try ──
  const featData = llmData?.features_to_try ?? []
  const featuresHtml = featData.length > 0 ? `
  <h2 id="section-features">建议尝试的功能</h2>
  <p style="font-size:13px;color:#64748b;margin-bottom:16px">将下方提示词粘贴到 OpenCode 聊天框，AI 会帮你设置好</p>
  <div class="features-section">
    ${featData.map((f) => `
    <div class="feature-card">
      <div class="feature-title">${escHtml(f.title ?? "")}</div>
      <div class="feature-why"><strong>为什么适合你：</strong>${escHtml(f.why ?? "")}</div>
      ${f.prompt ? `
      <div class="copyable-prompt-section">
        <div class="prompt-label">粘贴到 OpenCode：</div>
        <div class="copyable-prompt-row">
          <code class="copyable-prompt">${escHtml(f.prompt ?? "")}</code>
          <button class="copy-btn" onclick="copyText(this)">Copy</button>
        </div>
      </div>` : ""}
    </div>`).join("")}
  </div>` : ""

  // ── Fun Ending ──
  const funData = llmData?.fun_moment
  const funHtml = funData?.headline ? `
  <div class="fun-ending">
    <div class="fun-headline">"${escHtml(funData.headline)}"</div>
    ${funData.detail ? `<div class="fun-detail">${escHtml(funData.detail)}</div>` : ""}
  </div>` : ""

  // ── Session List ──
  const sessionListHtml = `
  <h2 id="section-sessions">会话列表（最近 ${Math.min(summaries.length, 60)} 个）</h2>
  <div class="session-grid">
    ${summaries.slice(0, 60).map((s) => `
    <div class="session-item">
      <div class="session-title">${escHtml(s.title || "(无标题)")}</div>
      <div class="session-meta">
        <span>${escHtml(s.date)}</span>
        <span>${escHtml(s.project)}</span>
        <span>${s.durationMin}分钟</span>
        <span>${s.userMsgs}条消息</span>
        <span class="tag green">+${s.linesAdded}</span>
        <span class="tag red">-${s.linesDeleted}</span>
        ${s.errors > 0 ? `<span class="tag yellow">⚠${s.errors}err</span>` : ""}
      </div>
      ${s.firstUserMessage ? `<div class="session-preview">${escHtml(s.firstUserMessage)}</div>` : ""}
    </div>`).join("")}
  </div>`

  const hasLlm = llmData !== null

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode Insights</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#f8fafc;color:#334155;line-height:1.65;padding:48px 24px}
  .container{max-width:800px;margin:0 auto}
  h1{font-size:32px;font-weight:700;color:#0f172a;margin-bottom:8px}
  h2{font-size:20px;font-weight:600;color:#0f172a;margin-top:48px;margin-bottom:16px}
  .subtitle{color:#64748b;font-size:15px;margin-bottom:32px}
  code{font-family:'SF Mono','Fira Code',monospace}

  /* Nav TOC */
  .nav-toc{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 32px;padding:16px;background:white;border-radius:8px;border:1px solid #e2e8f0}
  .nav-toc a{font-size:12px;color:#64748b;text-decoration:none;padding:6px 12px;border-radius:6px;background:#f1f5f9;transition:all .15s}
  .nav-toc a:hover{background:#e2e8f0;color:#334155}

  /* Stats row */
  .stats-row{display:flex;gap:24px;margin-bottom:40px;padding:20px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}
  .stat{text-align:center}
  .stat-value{font-size:24px;font-weight:700;color:#0f172a}
  .stat-label{font-size:11px;color:#64748b;text-transform:uppercase}

  /* At a Glance */
  .at-a-glance{background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border:1px solid #f59e0b;border-radius:12px;padding:20px 24px;margin-bottom:32px}
  .glance-title{font-size:16px;font-weight:700;color:#92400e;margin-bottom:16px}
  .glance-sections{display:flex;flex-direction:column;gap:12px}
  .glance-section{font-size:14px;color:#78350f;line-height:1.6}
  .glance-section strong{color:#92400e}
  .see-more{color:#b45309;text-decoration:none;font-size:13px}
  .see-more:hover{text-decoration:underline}

  /* Charts */
  .charts-row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:24px 0}
  .chart-card{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:16px}
  .chart-title{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:12px}
  .bar-row{display:flex;align-items:center;margin-bottom:6px}
  .bar-label{width:110px;font-size:11px;color:#475569;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{flex:1;height:6px;background:#f1f5f9;border-radius:3px;margin:0 8px}
  .bar-fill{height:100%;border-radius:3px}
  .bar-value{width:32px;font-size:11px;font-weight:500;color:#64748b;text-align:right}
  .empty{color:#94a3b8;font-size:13px}

  /* Narrative */
  .narrative{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px}
  .narrative p{margin-bottom:12px;font-size:14px;color:#475569;line-height:1.7}
  .narrative p:last-child{margin-bottom:0}

  /* Highlights */
  .big-wins{display:flex;flex-direction:column;gap:12px;margin-bottom:24px}
  .big-win{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px}
  .big-win-title{font-weight:600;font-size:15px;color:#166534;margin-bottom:8px}
  .big-win-desc{font-size:14px;color:#15803d;line-height:1.5}

  /* Friction */
  .friction-categories{display:flex;flex-direction:column;gap:16px;margin-bottom:24px}
  .friction-category{background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px}
  .friction-title{font-weight:600;font-size:15px;color:#991b1b;margin-bottom:8px}
  .friction-meta{font-size:13px;color:#7f1d1d;margin-bottom:6px;line-height:1.5}
  .friction-fix{font-size:13px;color:#334155;background:rgba(255,255,255,.6);padding:8px 12px;border-radius:4px;margin-top:8px;line-height:1.5}

  /* AGENTS.md section */
  .claude-md-section{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:20px;margin-bottom:24px}
  .claude-md-section h3{font-size:14px;font-weight:600;color:#1e40af;margin-bottom:12px}
  .claude-md-actions{margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #dbeafe}
  .copy-all-btn{background:#2563eb;color:white;border:none;border-radius:4px;padding:7px 14px;font-size:12px;cursor:pointer;font-weight:500;transition:all .2s}
  .copy-all-btn:hover{background:#1d4ed8}
  .copy-all-btn.copied{background:#16a34a}
  .claude-md-item{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;padding:10px 0;border-bottom:1px solid #dbeafe}
  .claude-md-item:last-child{border-bottom:none}
  .agmd-checkbox{margin-top:3px;flex-shrink:0}
  .claude-md-item label{display:flex;align-items:flex-start;gap:8px;flex:1;min-width:0}
  .cmd-code{background:white;padding:8px 12px;border-radius:4px;font-size:12px;color:#1e40af;border:1px solid #bfdbfe;display:block;white-space:pre-wrap;word-break:break-word;flex:1;line-height:1.5}
  .cmd-why{font-size:12px;color:#64748b;width:100%;padding-left:24px;margin-top:2px}

  /* Features */
  .features-section{display:flex;flex-direction:column;gap:12px;margin:16px 0 24px}
  .feature-card{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px}
  .feature-title{font-weight:600;font-size:15px;color:#0f172a;margin-bottom:6px}
  .feature-why{font-size:13px;color:#334155;margin-bottom:10px;line-height:1.5}
  .copyable-prompt-section{padding-top:10px;border-top:1px solid #d1fae5}
  .prompt-label{font-size:11px;font-weight:600;text-transform:uppercase;color:#64748b;margin-bottom:6px}
  .copyable-prompt-row{display:flex;align-items:flex-start;gap:8px}
  .copyable-prompt{flex:1;background:#f8fafc;padding:10px 12px;border-radius:4px;font-size:12px;color:#334155;border:1px solid #e2e8f0;white-space:pre-wrap;line-height:1.5;display:block}

  /* Copy button */
  .copy-btn{background:#e2e8f0;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;color:#475569;flex-shrink:0;transition:all .15s}
  .copy-btn:hover{background:#cbd5e1}

  /* Fun ending */
  .fun-ending{background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border:1px solid #fbbf24;border-radius:12px;padding:24px;margin-top:40px;text-align:center}
  .fun-headline{font-size:18px;font-weight:600;color:#78350f;margin-bottom:8px}
  .fun-detail{font-size:14px;color:#92400e}

  /* Session list */
  .session-grid{display:flex;flex-direction:column;gap:8px}
  .session-item{background:white;border:1px solid #e2e8f0;border-radius:6px;padding:12px}
  .session-title{font-weight:600;font-size:14px;color:#0f172a;margin-bottom:4px}
  .session-meta{font-size:12px;color:#64748b;display:flex;gap:12px;flex-wrap:wrap}
  .session-preview{font-size:12px;color:#94a3b8;margin-top:4px}
  .tag{border-radius:3px;padding:1px 5px;font-size:11px}
  .tag.green{color:#16a34a;background:#f0fdf4}
  .tag.red{color:#dc2626;background:#fef2f2}
  .tag.yellow{color:#d97706;background:#fffbeb}

  /* No LLM banner */
  .no-llm-banner{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px;margin-bottom:24px;font-size:14px;color:#9a3412}

  @media(max-width:640px){.charts-row{grid-template-columns:1fr}.stats-row{justify-content:center}}
</style>
</head>
<body>
<div class="container">
  <h1>OpenCode Insights</h1>
  <p class="subtitle">${totalUserMsgs} 条消息，${summaries.length} 个会话，${activeDays} 个活跃天 | ${new Date(SINCE).toLocaleDateString("zh-CN")} — ${new Date().toLocaleDateString("zh-CN")} | 生成于 ${new Date().toLocaleString("zh-CN")}</p>

  ${atAGlanceHtml}

  <nav class="nav-toc">
    <a href="#section-portrait">使用画像</a>
    <a href="#section-highlights">工作流亮点</a>
    <a href="#section-friction">摩擦点</a>
    <a href="#section-agents">AGENTS.md 建议</a>
    <a href="#section-features">建议功能</a>
    <a href="#section-sessions">会话列表</a>
  </nav>

  ${statsRowHtml}

  ${!hasLlm ? `<div class="no-llm-banner">⚠️ LLM 分析不可用（API 配置未找到或调用失败），以下仅展示统计数据。运行 <code>/insights</code> 命令可在聊天中获取 AI 分析。</div>` : ""}

  ${portraitHtml}
  ${chartsHtml}
  ${highlightsHtml}
  ${frictionHtml}
  ${agentsMdHtml}
  ${featuresHtml}
  ${sessionListHtml}
  ${funHtml}
</div>

<script>
function copyText(btn) {
  const code = btn.previousElementSibling
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = "Copied!"
    setTimeout(() => { btn.textContent = "Copy" }, 2000)
  })
}
function copySingle(i) {
  const cb = document.getElementById("agmd-" + i)
  if (!cb) return
  navigator.clipboard.writeText(cb.dataset.text).then(() => {
    const btn = cb.nextElementSibling.querySelector(".copy-btn")
    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy" }, 2000) }
  })
}
function copyAllChecked() {
  const items = [...document.querySelectorAll(".agmd-checkbox:checked")]
  const text = items.map(cb => cb.dataset.text).join("\n\n")
  const btn = document.querySelector(".copy-all-btn")
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      btn.textContent = "Copied " + items.length + " items!"
      btn.classList.add("copied")
      setTimeout(() => { btn.textContent = "Copy All Checked"; btn.classList.remove("copied") }, 2500)
    }
  })
}
</script>
</body>
</html>`
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const llmData = await callLLM(statsText)
const html = generateHtml(llmData)
writeFileSync(REPORT_PATH, html)
process.stderr.write(`\n✅ HTML 报告已保存至：${REPORT_PATH}\n`)
process.stderr.write(`   open "${REPORT_PATH}"\n`)
