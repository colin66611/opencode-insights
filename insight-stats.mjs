#!/usr/bin/env node
/**
 * OpenCode Insight – Data Extractor + HTML Renderer
 *
 * 默认模式：读 SQLite，输出结构化数据（供 OpenCode AI 分析）
 * --render  模式：读 AI 分析 JSON，生成 HTML 报告
 */
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileSync, readFileSync, existsSync } from "node:fs"

const DAYS = parseInt(process.argv.find((a) => /^\d+$/.test(a)) ?? "90")
const RENDER_MODE = process.argv.includes("--render")
const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db")
const REPORT_PATH = join(homedir(), ".local/share/opencode/insight-report.html")
const ANALYSIS_PATH = join(homedir(), ".local/share/opencode/insights-analysis.json")
const SINCE = Date.now() - DAYS * 24 * 60 * 60 * 1000

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function getFileExt(filePath) {
  const filename = (filePath ?? "").split("/").pop() ?? ""
  const dotIdx = filename.lastIndexOf(".")
  if (dotIdx <= 0) return null
  const ext = filename.slice(dotIdx).toLowerCase()
  return ext.length <= 6 ? ext : null
}

function extractFileExt(input) {
  const path = input?.filePath ?? input?.path ?? input?.file_path ?? null
  return typeof path === "string" ? getFileExt(path) : null
}

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH, { open: true })

// ─── Session Analysis ─────────────────────────────────────────────────────────
function analyzeSession(session) {
  const messages = db
    .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`)
    .all(session.id)
  const parts = db
    .prepare(`SELECT data, message_id FROM part WHERE session_id = ? ORDER BY time_created ASC`)
    .all(session.id)

  let userMsgs = 0, tokensIn = 0, tokensOut = 0, cost = 0
  let minTime = Infinity, maxTime = 0
  const models = new Set()
  const msgMap = new Map()

  for (const msg of messages) {
    const d = JSON.parse(msg.data)
    msgMap.set(msg.id, { role: d.role })
    if (d.role === "user") userMsgs++
    else if (d.role === "assistant" && d.modelID) models.add(d.modelID)
    if (msg.time_created < minTime) minTime = msg.time_created
    if (msg.time_created > maxTime) maxTime = msg.time_created
  }

  const tools = {}, fileExts = {}
  let errors = 0
  const userMessages = []

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
    if (d.type === "text" && typeof d.text === "string" && d.text.trim()) {
      const info = msgMap.get(part.message_id)
      if (info?.role === "user" && userMessages.length < 5) {
        const cleaned = d.text
          .replace(/^\[[\w-]+\][\s\S]*?---\n\n/m, "")
          .replace(/\[图片\]/g, "").trim()
        if (cleaned.length > 10 && !cleaned.includes("RESPOND WITH ONLY A VALID JSON OBJECT")) {
          userMessages.push(cleaned.slice(0, 300))
        }
      }
    }
  }

  return {
    id: session.id,
    title: session.title ?? "(无标题)",
    project: session.directory?.split("/").slice(-2).join("/") ?? "",
    date: new Date(session.time_created).toLocaleDateString("zh-CN"),
    durationMin: minTime !== Infinity && maxTime > minTime ? Math.round((maxTime - minTime) / 60000) : 0,
    userMsgs, tokensIn, tokensOut, cost,
    linesAdded: session.summary_additions ?? 0,
    linesDeleted: session.summary_deletions ?? 0,
    tools, fileExts, errors,
    userMessages,
    models: [...models],
  }
}

// ─── Aggregate Stats ──────────────────────────────────────────────────────────
function buildAggStats(summaries) {
  const allTools = {}, allExts = {}, projectMap = {}
  let totalUserMsgs = 0, totalToolCalls = 0, totalTokens = 0, totalErrors = 0
  let totalLinesAdded = 0, totalLinesDeleted = 0, totalDuration = 0

  for (const s of summaries) {
    totalUserMsgs += s.userMsgs
    totalTokens += s.tokensIn + s.tokensOut
    totalErrors += s.errors
    totalLinesAdded += s.linesAdded
    totalLinesDeleted += s.linesDeleted
    totalDuration += s.durationMin
    const tc = Object.values(s.tools).reduce((a, b) => a + b, 0)
    totalToolCalls += tc
    for (const [t, n] of Object.entries(s.tools)) allTools[t] = (allTools[t] ?? 0) + n
    for (const [e, n] of Object.entries(s.fileExts)) allExts[e] = (allExts[e] ?? 0) + n
    const p = projectMap[s.project] ?? { sessions: 0, msgs: 0 }
    p.sessions++; p.msgs += s.userMsgs
    projectMap[s.project] = p
  }

  return {
    totalSessions: summaries.length,
    activeDays: new Set(summaries.map((s) => s.date)).size,
    totalUserMsgs, totalToolCalls, totalTokens, totalErrors,
    totalLinesAdded, totalLinesDeleted,
    avgDuration: summaries.length > 0 ? Math.round(totalDuration / summaries.length) : 0,
    allModels: [...new Set(summaries.flatMap((s) => s.models))],
    topTools: Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 12),
    topExts: Object.entries(allExts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    topProjects: Object.entries(projectMap).sort((a, b) => b[1].sessions - a[1].sessions).slice(0, 8),
  }
}

// ─── Default Mode: Output Data for AI Analysis ────────────────────────────────
if (!RENDER_MODE) {
  const rawSessions = db
    .prepare(`SELECT id, title, directory, time_created, time_updated,
                     summary_additions, summary_deletions
              FROM session
              WHERE time_archived IS NULL AND time_created >= ?
              ORDER BY time_updated DESC`)
    .all(SINCE)

  process.stderr.write(`读取 ${rawSessions.length} 个会话数据...\n`)
  const summaries = rawSessions.map((s, i) => {
    if ((i + 1) % 20 === 0) process.stderr.write(`  ${i + 1}/${rawSessions.length}...\n`)
    return analyzeSession(s)
  })
  process.stderr.write(`完成，输出数据...\n`)

  const agg = buildAggStats(summaries)

  const lines = []
  lines.push(`# OpenCode 使用数据（最近 ${DAYS} 天）`)
  lines.push(``)
  lines.push(`## 总体统计`)
  lines.push(`- 时间范围：${new Date(SINCE).toLocaleDateString("zh-CN")} 至 ${new Date().toLocaleDateString("zh-CN")}`)
  lines.push(`- 总会话数：${agg.totalSessions}，活跃 ${agg.activeDays} 天`)
  lines.push(`- 总用户消息：${agg.totalUserMsgs} 条`)
  lines.push(`- 总工具调用：${agg.totalToolCalls} 次（错误 ${agg.totalErrors} 次）`)
  lines.push(`- 总 Token：${(agg.totalTokens / 1000).toFixed(0)}K`)
  lines.push(`- 代码净变更：+${agg.totalLinesAdded} / -${agg.totalLinesDeleted} 行`)
  lines.push(`- 平均会话时长：${agg.avgDuration} 分钟`)
  lines.push(`- 使用模型：${agg.allModels.join(", ") || "未记录"}`)
  lines.push(``)
  lines.push(`## 工具使用频率（Top 12）`)
  for (const [t, n] of agg.topTools) lines.push(`- ${t}: ${n}次`)
  lines.push(``)
  lines.push(`## 文件类型（Top 10）`)
  for (const [e, n] of agg.topExts) lines.push(`- ${e}: ${n}次`)
  lines.push(``)
  lines.push(`## 主要项目（按会话数）`)
  for (const [p, d] of agg.topProjects) lines.push(`- ${p}：${d.sessions}个会话，${d.msgs}条消息`)
  lines.push(``)
  lines.push(`## 各会话详情（最近 ${Math.min(summaries.length, 20)} 个）`)

  for (const s of summaries.slice(0, 20)) {
    lines.push(``)
    lines.push(`### [${s.date}] ${s.title}`)
    lines.push(`- 项目：${s.project} | 时长：${s.durationMin}分钟 | 消息：${s.userMsgs}条${s.errors > 0 ? ` | ⚠️错误：${s.errors}次` : ""}`)
    lines.push(`- 工具：${Object.entries(s.tools).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t,n])=>`${t}(${n})`).join(", ") || "无"}`)
    if (s.userMessages.length > 0) {
      lines.push(`- 用户说：${s.userMessages.slice(0, 2).map(m => m.replace(/\n/g, " ").slice(0, 100)).join(" / ")}`)
    }
  }

  process.stdout.write(lines.join("\n") + "\n")
  process.exit(0)
}

// ─── Render Mode: Analysis JSON → HTML ────────────────────────────────────────
if (!existsSync(ANALYSIS_PATH)) {
  process.stderr.write(`❌ 未找到分析文件：${ANALYSIS_PATH}\n`)
  process.exit(1)
}

const analysis = JSON.parse(readFileSync(ANALYSIS_PATH, "utf8"))

// Re-read stats for charts
const rawSessions = db
  .prepare(`SELECT id, title, directory, time_created, summary_additions, summary_deletions
            FROM session WHERE time_archived IS NULL AND time_created >= ?
            ORDER BY time_updated DESC`)
  .all(SINCE)
const summaries = rawSessions.map(analyzeSession)
const agg = buildAggStats(summaries)

// ─── HTML Generation ──────────────────────────────────────────────────────────
function barRow(label, value, max, color = "#6366f1") {
  const w = Math.round((value / Math.max(max, 1)) * 100)
  return `
  <div class="bar-row">
    <div class="bar-label">${escHtml(label)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>
    <div class="bar-value">${value}</div>
  </div>`
}

function markdownToHtml(md) {
  if (!md) return ""
  return md.split("\n\n").map((p) => {
    let h = escHtml(p)
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    h = h.replace(/^[•\-] /gm, "• ")
    h = h.replace(/\n/g, "<br>")
    return `<p>${h}</p>`
  }).join("\n")
}

const ag = analysis.at_a_glance ?? {}
const atAGlanceHtml = `
<div class="at-a-glance" id="section-glance">
  <div class="glance-title">At a Glance</div>
  <div class="glance-sections">
    ${ag.summary ? `<div class="glance-section">${escHtml(ag.summary)}</div>` : ""}
    ${ag.whats_working ? `<div class="glance-section"><strong>✅ 什么在发挥作用：</strong>${escHtml(ag.whats_working)} <a href="#section-highlights" class="see-more">工作流亮点 →</a></div>` : ""}
    ${ag.whats_hindering ? `<div class="glance-section"><strong>⚠️ 什么在阻碍你：</strong>${escHtml(ag.whats_hindering)} <a href="#section-friction" class="see-more">摩擦点分析 →</a></div>` : ""}
    ${ag.quick_wins ? `<div class="glance-section"><strong>⚡ 立即可以改进：</strong>${escHtml(ag.quick_wins)} <a href="#section-agents" class="see-more">AGENTS.md 建议 →</a></div>` : ""}
    ${ag.ambitious_workflows ? `<div class="glance-section"><strong>🚀 可以更进一步：</strong>${escHtml(ag.ambitious_workflows)} <a href="#section-horizon" class="see-more">展望 →</a></div>` : ""}
  </div>
</div>`

const statsRowHtml = `
<div class="stats-row">
  <div class="stat"><div class="stat-value">${agg.totalSessions}</div><div class="stat-label">Sessions</div></div>
  <div class="stat"><div class="stat-value">${agg.activeDays}</div><div class="stat-label">Active Days</div></div>
  <div class="stat"><div class="stat-value">${agg.totalUserMsgs}</div><div class="stat-label">Messages</div></div>
  <div class="stat"><div class="stat-value">${agg.totalToolCalls}</div><div class="stat-label">Tool Calls</div></div>
  <div class="stat"><div class="stat-value">${(agg.totalTokens / 1000).toFixed(0)}K</div><div class="stat-label">Tokens</div></div>
  <div class="stat"><div class="stat-value" style="color:#22c55e">+${agg.totalLinesAdded}</div><div class="stat-label">Lines Added</div></div>
  <div class="stat"><div class="stat-value" style="color:#ef4444">-${agg.totalLinesDeleted}</div><div class="stat-label">Lines Deleted</div></div>
  <div class="stat"><div class="stat-value">${agg.avgDuration}m</div><div class="stat-label">Avg Session</div></div>
</div>`

const portraitHtml = (analysis.project_areas || analysis.interaction_style) ? `
<h2 id="section-portrait">使用画像</h2>
<div class="narrative">
  ${markdownToHtml(analysis.project_areas ?? "")}
  ${markdownToHtml(analysis.interaction_style ?? "")}
</div>` : ""

const chartsHtml = `
<div class="charts-row">
  <div class="chart-card">
    <div class="chart-title">工具使用频率</div>
    ${agg.topTools.map(([t, n]) => barRow(t, n, agg.topTools[0]?.[1] ?? 1, "#6366f1")).join("")}
  </div>
  <div class="chart-card">
    <div class="chart-title">文件类型分布</div>
    ${agg.topExts.length > 0
      ? agg.topExts.map(([e, n]) => barRow(e, n, agg.topExts[0]?.[1] ?? 1, "#8b5cf6")).join("")
      : '<span class="empty">暂无数据</span>'}
  </div>
</div>
<div class="charts-row">
  <div class="chart-card">
    <div class="chart-title">主要项目</div>
    ${agg.topProjects.map(([p, d]) => barRow(p, d.sessions, agg.topProjects[0]?.[1]?.sessions ?? 1, "#06b6d4")).join("")}
  </div>
  <div class="chart-card">
    <div class="chart-title">使用模型</div>
    ${agg.allModels.map((m) => `<div style="font-size:12px;color:#475569;padding:4px 0;border-bottom:1px solid #f1f5f9">${escHtml(m)}</div>`).join("") || '<span class="empty">未记录</span>'}
  </div>
</div>`

const hlData = analysis.what_works ?? []
const highlightsHtml = hlData.length > 0 ? `
<h2 id="section-highlights">工作流亮点</h2>
<div class="big-wins">
  ${hlData.map((h) => `
  <div class="big-win">
    <div class="big-win-title">${escHtml(h.title ?? "")}</div>
    <div class="big-win-desc">${escHtml(h.description ?? "")}</div>
  </div>`).join("")}
</div>` : ""

const frData = analysis.friction_analysis ?? []
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

const agMdData = analysis.agents_md_additions ?? []
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

const featData = analysis.features_to_try ?? []
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

const horizonText = analysis.on_the_horizon ?? ""
const horizonHtml = horizonText ? `
<h2 id="section-horizon">展望</h2>
<div class="horizon-card">${markdownToHtml(horizonText)}</div>` : ""

const funData = analysis.fun_ending ?? {}
const funHtml = funData.headline ? `
<div class="fun-ending">
  <div class="fun-headline">"${escHtml(funData.headline)}"</div>
  ${funData.detail ? `<div class="fun-detail">${escHtml(funData.detail)}</div>` : ""}
</div>` : ""

const sessionListHtml = `
<h2 id="section-sessions">会话列表（最近 ${Math.min(summaries.length, 60)} 个）</h2>
<div class="session-grid">
  ${summaries.slice(0, 60).map((s) => `
  <div class="session-item">
    <div class="session-title">${escHtml(s.title)}</div>
    <div class="session-meta">
      <span>${escHtml(s.date)}</span><span>${escHtml(s.project)}</span>
      <span>${s.durationMin}分钟</span><span>${s.userMsgs}条消息</span>
      <span class="tag green">+${s.linesAdded}</span><span class="tag red">-${s.linesDeleted}</span>
      ${s.errors > 0 ? `<span class="tag yellow">⚠${s.errors}err</span>` : ""}
    </div>
    ${s.userMessages[0] ? `<div class="session-preview">${escHtml(s.userMessages[0].replace(/\n/g, " "))}</div>` : ""}
  </div>`).join("")}
</div>`

const html = `<!DOCTYPE html>
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
  .nav-toc{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 32px;padding:16px;background:white;border-radius:8px;border:1px solid #e2e8f0}
  .nav-toc a{font-size:12px;color:#64748b;text-decoration:none;padding:6px 12px;border-radius:6px;background:#f1f5f9;transition:all .15s}
  .nav-toc a:hover{background:#e2e8f0;color:#334155}
  .stats-row{display:flex;gap:24px;margin-bottom:40px;padding:20px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}
  .stat{text-align:center}
  .stat-value{font-size:24px;font-weight:700;color:#0f172a}
  .stat-label{font-size:11px;color:#64748b;text-transform:uppercase}
  .at-a-glance{background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border:1px solid #f59e0b;border-radius:12px;padding:20px 24px;margin-bottom:32px}
  .glance-title{font-size:16px;font-weight:700;color:#92400e;margin-bottom:16px}
  .glance-sections{display:flex;flex-direction:column;gap:12px}
  .glance-section{font-size:14px;color:#78350f;line-height:1.6}
  .glance-section strong{color:#92400e}
  .see-more{color:#b45309;text-decoration:none;font-size:13px}
  .see-more:hover{text-decoration:underline}
  .charts-row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:24px 0}
  .chart-card{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:16px}
  .chart-title{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:12px}
  .bar-row{display:flex;align-items:center;margin-bottom:6px}
  .bar-label{width:110px;font-size:11px;color:#475569;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{flex:1;height:6px;background:#f1f5f9;border-radius:3px;margin:0 8px}
  .bar-fill{height:100%;border-radius:3px}
  .bar-value{width:32px;font-size:11px;font-weight:500;color:#64748b;text-align:right}
  .empty{color:#94a3b8;font-size:13px}
  .narrative{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px}
  .narrative p{margin-bottom:12px;font-size:14px;color:#475569;line-height:1.7}
  .narrative p:last-child{margin-bottom:0}
  .big-wins{display:flex;flex-direction:column;gap:12px;margin-bottom:24px}
  .big-win{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px}
  .big-win-title{font-weight:600;font-size:15px;color:#166534;margin-bottom:8px}
  .big-win-desc{font-size:14px;color:#15803d;line-height:1.5}
  .friction-categories{display:flex;flex-direction:column;gap:16px;margin-bottom:24px}
  .friction-category{background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px}
  .friction-title{font-weight:600;font-size:15px;color:#991b1b;margin-bottom:8px}
  .friction-meta{font-size:13px;color:#7f1d1d;margin-bottom:6px;line-height:1.5}
  .friction-fix{font-size:13px;color:#334155;background:rgba(255,255,255,.6);padding:8px 12px;border-radius:4px;margin-top:8px;line-height:1.5}
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
  .features-section{display:flex;flex-direction:column;gap:12px;margin:16px 0 24px}
  .feature-card{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px}
  .feature-title{font-weight:600;font-size:15px;color:#0f172a;margin-bottom:6px}
  .feature-why{font-size:13px;color:#334155;margin-bottom:10px;line-height:1.5}
  .copyable-prompt-section{padding-top:10px;border-top:1px solid #d1fae5}
  .prompt-label{font-size:11px;font-weight:600;text-transform:uppercase;color:#64748b;margin-bottom:6px}
  .copyable-prompt-row{display:flex;align-items:flex-start;gap:8px}
  .copyable-prompt{flex:1;background:#f8fafc;padding:10px 12px;border-radius:4px;font-size:12px;color:#334155;border:1px solid #e2e8f0;white-space:pre-wrap;line-height:1.5;display:block}
  .copy-btn{background:#e2e8f0;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;color:#475569;flex-shrink:0;transition:all .15s}
  .copy-btn:hover{background:#cbd5e1}
  .horizon-card{background:linear-gradient(135deg,#f3e8ff 0%,#e9d5ff 100%);border:1px solid #c084fc;border-radius:12px;padding:20px 24px;margin-bottom:24px}
  .horizon-card p{font-size:14px;color:#6b21a8;line-height:1.7;margin-bottom:10px}
  .horizon-card p:last-child{margin-bottom:0}
  .fun-ending{background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border:1px solid #fbbf24;border-radius:12px;padding:24px;margin-top:40px;text-align:center}
  .fun-headline{font-size:18px;font-weight:600;color:#78350f;margin-bottom:8px}
  .fun-detail{font-size:14px;color:#92400e}
  .session-grid{display:flex;flex-direction:column;gap:8px}
  .session-item{background:white;border:1px solid #e2e8f0;border-radius:6px;padding:12px}
  .session-title{font-weight:600;font-size:14px;color:#0f172a;margin-bottom:4px}
  .session-meta{font-size:12px;color:#64748b;display:flex;gap:12px;flex-wrap:wrap}
  .session-preview{font-size:12px;color:#94a3b8;margin-top:4px}
  .tag{border-radius:3px;padding:1px 5px;font-size:11px}
  .tag.green{color:#16a34a;background:#f0fdf4}
  .tag.red{color:#dc2626;background:#fef2f2}
  .tag.yellow{color:#d97706;background:#fffbeb}
  @media(max-width:640px){.charts-row{grid-template-columns:1fr}.stats-row{justify-content:center}}
</style>
</head>
<body>
<div class="container">
  <h1>OpenCode Insights</h1>
  <p class="subtitle">${agg.totalUserMsgs} 条消息，${agg.totalSessions} 个会话，${agg.activeDays} 个活跃天 | ${new Date(SINCE).toLocaleDateString("zh-CN")} — ${new Date().toLocaleDateString("zh-CN")} | 生成于 ${new Date().toLocaleString("zh-CN")}</p>

  ${atAGlanceHtml}

  <nav class="nav-toc">
    <a href="#section-glance">At a Glance</a>
    <a href="#section-portrait">使用画像</a>
    <a href="#section-highlights">工作流亮点</a>
    <a href="#section-friction">摩擦点</a>
    <a href="#section-agents">AGENTS.md 建议</a>
    <a href="#section-features">建议功能</a>
    <a href="#section-horizon">展望</a>
    <a href="#section-sessions">会话列表</a>
  </nav>

  ${statsRowHtml}
  ${portraitHtml}
  ${chartsHtml}
  ${highlightsHtml}
  ${frictionHtml}
  ${agentsMdHtml}
  ${featuresHtml}
  ${horizonHtml}
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

writeFileSync(REPORT_PATH, html)
process.stderr.write(`✅ HTML 报告已保存至：${REPORT_PATH}\n`)
