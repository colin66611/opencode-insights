#!/usr/bin/env node
/**
 * OpenCode Insight – Full Report Generator (v2 – Two-Stage Analysis)
 * 对标 Claude Code insights.ts 的两阶段分析：
 *   Phase 1: SQLite 读取 SessionMeta（纯统计）
 *   Phase 2: 逐 session 提取 Facets（完整 transcript → LLM，带缓存）
 *   Phase 3: 聚合 AggregatedData
 *   Phase 4: 6+1 并行 Section 生成
 *   Phase 5: HTML 报告生成
 */
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"

// ─── Config ───────────────────────────────────────────────────────────────────
const DAYS = parseInt(process.argv[2] ?? "90")
const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db")
const REPORT_PATH = join(homedir(), ".local/share/opencode/insight-report.html")
const FACETS_DIR = join(homedir(), ".local/share/opencode/facets")
const CONFIG_PATH = join(homedir(), ".config/opencode/opencode.json")
const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json")
const SINCE = Date.now() - DAYS * 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 12 * 60 * 60 * 1000

mkdirSync(FACETS_DIR, { recursive: true })

// ─── API Config ───────────────────────────────────────────────────────────────
// apiKey 存在 auth.json（按 provider id 索引），baseURL 存在 opencode.json provider.options
// Anthropic 格式用 /messages，其余用 /chat/completions（OpenAI 兼容）
const PROVIDER_BASE_URLS = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
}

function loadApiConfig() {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    const auth = existsSync(AUTH_PATH) ? JSON.parse(readFileSync(AUTH_PATH, "utf8")) : {}
    const disabled = new Set(cfg.disabled_providers ?? [])

    for (const [id, provider] of Object.entries(cfg.provider ?? {})) {
      if (disabled.has(id)) continue
      const opts = provider.options ?? {}
      // apiKey 优先从 auth.json 取，再从 opencode.json options 取
      const apiKey = auth[id]?.key ?? opts.apiKey
      const baseURL = opts.baseURL ?? PROVIDER_BASE_URLS[id]
      if (!apiKey || !baseURL) {
        process.stderr.write(`  [debug] 跳过 ${id}: apiKey=${!!apiKey} baseURL=${!!baseURL}\n`)
        continue
      }
      const models = Object.keys(provider.models ?? {})
      // 优先选文本生成能力强的模型，跳过 embedding/image 等
      const preferred = [
        "claude-opus-4-5","claude-sonnet-4-5","claude-3-5-sonnet-latest",
        "gpt-4o","gpt-4o-mini",
        "kimi-k2.5","qwen3-coder-plus","qwen3.5-plus","qwen3-max",
        "glm-5","glm-4.7","deepseek-chat","deepseek-coder",
        "llama-3.3-70b-versatile","mistral-large-latest",
      ]
      const model = preferred.find((m) => models.includes(m)) ?? models[0]
      if (model) {
        process.stderr.write(`  [debug] 选用 provider=${id} model=${model} baseURL=${baseURL.slice(0,40)}...\n`)
        return { baseURL, apiKey, model, provider: id }
      }
      process.stderr.write(`  [debug] 跳过 ${id}: 无可用 model（${models.join(",")}）\n`)
    }
  } catch (e) {
    process.stderr.write(`⚠️ 读取 API 配置失败: ${e.message}\n`)
  }
  process.stderr.write(`⚠️ 未找到可用 provider。请检查:\n`)
  process.stderr.write(`   配置文件: ${CONFIG_PATH}  存在=${existsSync(CONFIG_PATH)}\n`)
  process.stderr.write(`   认证文件: ${AUTH_PATH}  存在=${existsSync(AUTH_PATH)}\n`)
  if (existsSync(AUTH_PATH)) {
    try {
      const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"))
      process.stderr.write(`   auth.json providers: ${Object.keys(auth).join(", ")}\n`)
    } catch (_) {}
  }
  return null
}

const API_CFG = loadApiConfig()

async function callLLM(messages, maxTokens = 4096) {
  if (!API_CFG) throw new Error("未找到可用的 API 配置")

  // Anthropic 格式：provider id 是 anthropic，或 baseURL 路径含 anthropic（兼容代理）
  const isAnthropicFormat = API_CFG.provider === "anthropic" ||
    API_CFG.baseURL.includes("anthropic")
  const url = isAnthropicFormat
    ? `${API_CFG.baseURL.replace(/\/$/, "")}/messages`
    : `${API_CFG.baseURL.replace(/\/$/, "")}/chat/completions`

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_CFG.apiKey}`,
      ...(isAnthropicFormat ? {
        "x-api-key": API_CFG.apiKey,
        "anthropic-version": "2023-06-01",
      } : {}),
    },
    body: JSON.stringify({ model: API_CFG.model, max_tokens: maxTokens, messages }),
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`API ${resp.status}: ${err.slice(0, 200)}`)
  }
  const json = await resp.json()
  // Anthropic: content[].text；OpenAI: choices[0].message.content
  const textBlock = Array.isArray(json.content) ? json.content.find((b) => b.type === "text") : null
  return textBlock?.text ?? json.choices?.[0]?.message?.content ?? ""
}

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH, { open: true })

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function parseJson(text) {
  const stripped = text.replace(/```(?:json)?\n?/g, "").trim()
  // 先直接整体 parse
  try { return JSON.parse(stripped) } catch (_) {}
  // 回退：截取 { ... } 范围
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("未找到 JSON object")
  return JSON.parse(stripped.slice(start, end + 1))
}

function parseJsonArray(text) {
  const stripped = text.replace(/```(?:json)?\n?/g, "").trim()
  // 先直接整体 parse
  try { return JSON.parse(stripped) } catch (_) {}
  // 回退：截取 [ ... ] 范围
  const start = stripped.indexOf("[")
  const end = stripped.lastIndexOf("]")
  if (start === -1 || end === -1) throw new Error("未找到 JSON array")
  return JSON.parse(stripped.slice(start, end + 1))
}

// ─── Phase 1: SessionMeta ─────────────────────────────────────────────────────
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
    else if (d.role === "assistant") { assistantMsgs++; if (d.modelID) models.add(d.modelID) }
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
      if (info?.role === "user") {
        firstUserMessage = d.text.replace(/^\[[\w-]+\][\s\S]*?---\n\n/m, "")
          .replace(/\[图片\]/g, "").trim().slice(0, 200).replace(/\n/g, " ")
      }
    }
  }

  return {
    id: session.id, title: session.title,
    project: session.directory.split("/").slice(-2).join("/"),
    date: new Date(session.time_created).toLocaleDateString("zh-CN"),
    durationMin: minTime !== Infinity && maxTime > minTime ? Math.round((maxTime - minTime) / 60000) : 0,
    userMsgs, assistantMsgs, tokensIn, tokensOut, cost,
    linesAdded: session.summary_additions ?? 0, linesDeleted: session.summary_deletions ?? 0,
    tools, fileExts, errors, firstUserMessage, models: [...models],
  }
}

// ─── Phase 2: Transcript + Facet Extraction ───────────────────────────────────
function isMetaSession(sessionId) {
  const parts = db
    .prepare(`SELECT p.data FROM part p JOIN message m ON p.message_id = m.id
              WHERE p.session_id = ? AND json_extract(m.data,'$.role')='user'
              AND json_extract(p.data,'$.type')='text' LIMIT 3`)
    .all(sessionId)
  for (const row of parts) {
    const d = JSON.parse(row.data)
    if ((d.text ?? "").includes("RESPOND WITH ONLY A VALID JSON OBJECT")) return true
  }
  return false
}

function buildTranscript(sessionId) {
  const rows = db
    .prepare(`SELECT json_extract(m.data,'$.role') as role,
                     json_extract(p.data,'$.text') as text,
                     json_extract(p.data,'$.type') as type,
                     json_extract(p.data,'$.tool') as tool
              FROM part p JOIN message m ON p.message_id = m.id
              WHERE p.session_id = ?
                AND json_extract(p.data,'$.type') IN ('text','tool')
              ORDER BY p.time_created ASC`)
    .all(sessionId)

  const lines = []
  for (const row of rows) {
    if (row.type === "text" && row.role === "user" && row.text) {
      lines.push(`[User]: ${row.text.slice(0, 500)}`)
    } else if (row.type === "text" && row.role === "assistant" && row.text) {
      lines.push(`[Assistant]: ${row.text.slice(0, 300)}`)
    } else if (row.type === "tool" && row.tool) {
      lines.push(`[Tool: ${row.tool}]`)
    }
  }
  return lines.join("\n")
}

const FACET_EXTRACTION_PROMPT = `You are analyzing a single coding session transcript from OpenCode (an AI coding assistant). Extract structured information about this session.

Analyze the transcript and return a JSON object with EXACTLY this structure (no other text, just JSON):
{
  "goal_categories": ["list of 1-3 category strings like 'debugging', 'feature_implementation', 'refactoring', 'code_review', 'configuration', 'documentation', 'testing', 'architecture'"],
  "outcome": "completed" | "partial" | "abandoned" | "unclear",
  "user_satisfaction": "high" | "medium" | "low" | "unclear",
  "friction_count": <number of times user seemed frustrated, confused, or had to repeat themselves>,
  "primary_success": "<1 sentence describing the main thing accomplished, or null if nothing accomplished>",
  "brief_summary": "<2-3 sentence summary of what was worked on and how it went>",
  "friction_detail": "<if friction_count > 0: describe the main friction point in 1-2 sentences, else null>",
  "user_instructions_to_claude": ["list of explicit reusable instructions the user gave the AI, e.g. 'always use TypeScript', 'don't add comments', 'use Chinese'. Only include instructions that would apply to future sessions, not one-off requests"]
}

IMPORTANT: user_instructions_to_claude should capture standing instructions the user explicitly stated (not inferred), that would be worth putting in AGENTS.md for future sessions.`

async function extractFacets(sessionId, transcript) {
  const cachePath = join(FACETS_DIR, `${sessionId}.json`)

  // 检查缓存
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"))
      if (cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data
    } catch (_) {}
  }

  const text = await callLLM([{
    role: "user",
    content: `${FACET_EXTRACTION_PROMPT}\n\n===SESSION TRANSCRIPT===\n${transcript}`
  }], 1024)

  let data
  try {
    data = parseJson(text)
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e.message} | LLM 返回前200字: ${text.slice(0, 200)}`)
  }
  writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }))
  return data
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let idx = 0
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

// ─── Phase 3: Aggregate ───────────────────────────────────────────────────────
function aggregateData(summaries, facetsMap) {
  const goalCounts = {}, outcomeCounts = {}, satisfactionCounts = {}, frictionCounts = { low: 0, high: 0 }
  const sessionSummaries = [], frictionDetails = [], userInstructions = []

  for (const s of summaries) {
    const f = facetsMap.get(s.id)
    if (!f) continue
    for (const g of f.goal_categories ?? []) goalCounts[g] = (goalCounts[g] ?? 0) + 1
    const oc = f.outcome ?? "unclear"
    outcomeCounts[oc] = (outcomeCounts[oc] ?? 0) + 1
    const sat = f.user_satisfaction ?? "unclear"
    satisfactionCounts[sat] = (satisfactionCounts[sat] ?? 0) + 1
    if ((f.friction_count ?? 0) > 0) frictionCounts.high++
    else frictionCounts.low++
    if (f.brief_summary) sessionSummaries.push(`[${s.date}] ${s.title}: ${f.brief_summary}`)
    if (f.friction_detail) frictionDetails.push(`[${s.title}]: ${f.friction_detail}`)
    for (const instr of f.user_instructions_to_claude ?? []) {
      if (instr && !userInstructions.includes(instr)) userInstructions.push(instr)
    }
  }

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

  return {
    total_sessions: summaries.length,
    sessions_with_facets: facetsMap.size,
    date_range: { start: new Date(SINCE).toLocaleDateString("zh-CN"), end: new Date().toLocaleDateString("zh-CN") },
    topTools, topExts, topProjects,
    goal_categories: goalCounts, outcomes: outcomeCounts,
    satisfaction: satisfactionCounts, friction: frictionCounts,
    session_summaries: sessionSummaries,
    friction_details: frictionDetails,
    user_instructions: userInstructions,
  }
}

// ─── Phase 4: Section Prompts ─────────────────────────────────────────────────
const OPENCODE_FEATURES = `OPENCODE FEATURES REFERENCE:
1. MCP Servers - Connect external tools via the 'mcp' field in opencode.json (databases, APIs, custom tools)
2. Custom Commands - Place .md files in ~/.config/opencode/commands/, trigger with /commandname
3. Plugins - Place .ts files in ~/.config/opencode/plugins/, register custom tools and hooks
4. Custom Agents - Define specialized agents via the 'agent' field in opencode.json
5. AGENTS.md - Place in project root, auto-injected as instructions in every conversation`

function buildDataContext(agg) {
  const topToolsStr = agg.topTools.slice(0, 8).map(([t, n]) => `  ${t}: ${n}`).join("\n")
  const topExtsStr = agg.topExts.slice(0, 6).map(([e, n]) => `  ${e}: ${n}`).join("\n")
  const topProjectsStr = agg.topProjects.slice(0, 5).map(([p, d]) => `  ${p}: ${d.sessions} sessions`).join("\n")
  const goalsStr = Object.entries(agg.goal_categories).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([g, n]) => `  ${g}: ${n}`).join("\n")
  const outcomesStr = Object.entries(agg.outcomes).map(([k, v]) => `  ${k}: ${v}`).join("\n")
  const satisfactionStr = Object.entries(agg.satisfaction).map(([k, v]) => `  ${k}: ${v}`).join("\n")
  const summariesStr = agg.session_summaries.slice(0, 30).join("\n")
  const frictionStr = agg.friction_details.slice(0, 15).join("\n")
  const instructionsStr = agg.user_instructions.length > 0
    ? agg.user_instructions.map((i, n) => `  ${n + 1}. ${i}`).join("\n")
    : "  (none detected)"

  return `STATISTICS:
Total sessions analyzed: ${agg.total_sessions} (sessions with full analysis: ${agg.sessions_with_facets})
Date range: ${agg.date_range.start} to ${agg.date_range.end}

TOP TOOLS USED:
${topToolsStr}

FILE TYPES TOUCHED:
${topExtsStr}

PROJECTS:
${topProjectsStr}

GOAL CATEGORIES:
${goalsStr}

OUTCOMES:
${outcomesStr}

USER SATISFACTION:
${satisfactionStr}

SESSION SUMMARIES:
${summariesStr}

FRICTION DETAILS:
${frictionStr}

USER INSTRUCTIONS TO AI (explicit instructions user gave across sessions):
${instructionsStr}`
}

const SECTION_PROMPTS = {
  project_areas: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

Generate a "Project Areas & Goals" analysis. In 2-3 paragraphs, describe:
- What kinds of work this developer focuses on (based on goal categories and projects)
- Their primary use cases for AI assistance
- The scope and nature of their coding work

Write in second person ("You primarily work on..."). Be specific and insightful based on the data. Keep it concise but meaningful. Respond in Chinese.`,

  interaction_style: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

Generate an "Interaction Style & Patterns" analysis. In 2-3 paragraphs, describe:
- How this developer interacts with AI (session length, message patterns, tool usage patterns)
- Their workflow style (iterative vs. large requests, how they structure work)
- Any notable patterns in how they use AI coding assistance

Write in second person. Be specific. Respond in Chinese.`,

  what_works: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

Generate 3 "Workflow Highlights" — patterns that are working well for this developer.

For each highlight, return a JSON object in this array:
[
  {
    "title": "highlight title (5-10 chars)",
    "description": "2-3 sentences describing what's working well and why it's effective. Be specific to their data."
  }
]

Return ONLY the JSON array. Respond in Chinese.`,

  friction_analysis: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

Generate 3 "Friction Points" — bottlenecks or inefficiencies in their workflow.

For each friction point, return a JSON object:
[
  {
    "title": "friction point title (5-10 chars)",
    "symptom": "what the symptom looks like (1 sentence)",
    "cause": "root cause analysis (1 sentence)",
    "fix": "specific actionable fix they can implement (1-2 sentences)"
  }
]

Return ONLY the JSON array. Base your analysis on the friction details and session data. Respond in Chinese.`,

  suggestions: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

${OPENCODE_FEATURES}

Generate two things:

1. AGENTS_MD_SUGGESTIONS: 5-7 specific rules for their AGENTS.md file, based on the "USER INSTRUCTIONS TO AI" section above. PRIORITIZE instructions that appear MULTIPLE TIMES or are clearly important to this user. Only include instructions that would genuinely help. Format as actual AGENTS.md content they can paste directly.

2. FEATURES_TO_TRY: 3 OpenCode features from the FEATURES REFERENCE that would most benefit this specific developer based on their usage patterns.

Return a JSON object:
{
  "agents_md_additions": [
    {
      "addition": "the actual text to add to AGENTS.md (markdown, specific rule or preference, 1-3 lines)",
      "why": "why this would help their AI interactions (under 30 chars)"
    }
  ],
  "features_to_try": [
    {
      "title": "feature name (5-10 chars)",
      "why": "why it fits this developer's patterns (under 40 chars)",
      "prompt": "a prompt they can paste into OpenCode to try this feature (under 50 chars)"
    }
  ]
}

Return ONLY the JSON object. Respond in Chinese.`,

  on_the_horizon: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

Generate an "On the Horizon" section — 2-3 sentences about emerging patterns or opportunities you see in their workflow that they haven't fully explored yet. What could they accomplish if they leaned further into their strengths or addressed their main friction point?

Write in second person, forward-looking and encouraging. Respond in Chinese.`,

  fun_ending: (ctx) => `You are analyzing OpenCode (AI coding assistant) usage data for a developer.

${ctx}

Generate a fun, memorable closing for their insight report. Find one interesting, amusing, or noteworthy moment or pattern from their sessions and highlight it.

Return a JSON object:
{
  "headline": "a memorable quote or observation from their sessions (under 30 chars)",
  "detail": "a brief explanation (under 50 chars)"
}

Return ONLY the JSON. Respond in Chinese.`,
}

async function generateSection(name, prompt) {
  try {
    const text = await callLLM([{ role: "user", content: prompt }], 2048)
    return { name, text, ok: true }
  } catch (e) {
    process.stderr.write(`⚠️ Section ${name} 生成失败: ${e.message}\n`)
    return { name, text: "", ok: false }
  }
}

// ─── Phase 5: HTML Generation ─────────────────────────────────────────────────
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
    h = h.replace(/^[•-] /gm, "• ")
    h = h.replace(/\n/g, "<br>")
    return `<p>${h}</p>`
  }).join("\n")
}

function generateHtml(summaries, agg, sections, atAGlance) {
  const totalUserMsgs = summaries.reduce((s, x) => s + x.userMsgs, 0)
  const totalToolCalls = summaries.reduce((s, x) => s + Object.values(x.tools).reduce((a, b) => a + b, 0), 0)
  const totalTokens = summaries.reduce((s, x) => s + x.tokensIn + x.tokensOut, 0)
  const totalErrors = summaries.reduce((s, x) => s + x.errors, 0)
  const totalLinesAdded = summaries.reduce((s, x) => s + x.linesAdded, 0)
  const totalLinesDeleted = summaries.reduce((s, x) => s + x.linesDeleted, 0)
  const activeDays = new Set(summaries.map((s) => s.date)).size
  const avgDuration = summaries.length > 0
    ? Math.round(summaries.reduce((s, x) => s + x.durationMin, 0) / summaries.length) : 0
  const allModels = new Set(summaries.flatMap((s) => s.models))

  const getSectionText = (name) => sections.find((s) => s.name === name)?.text ?? ""

  // ── at_a_glance ──
  let ag = null
  if (atAGlance) {
    try { ag = parseJson(atAGlance) } catch (e) {
      process.stderr.write(`⚠️ at_a_glance 解析失败: ${e.message}\n`)
      const cleanSummary = atAGlance.replace(/```(?:json)?\n?/g, "").trim()
      ag = { summary: cleanSummary, whats_working: null, whats_hindering: null, quick_wins: null, ambitious_workflows: null }
    }
  }

  const atAGlanceHtml = ag ? `
  <div class="at-a-glance" id="section-glance">
    <div class="glance-title">At a Glance</div>
    <div class="glance-sections">
      ${ag.summary ? `<div class="glance-section">${escHtml(ag.summary)}</div>` : ""}
      ${ag.whats_working ? `<div class="glance-section"><strong>✅ 什么在发挥作用：</strong>${escHtml(ag.whats_working)} <a href="#section-highlights" class="see-more">工作流亮点 →</a></div>` : ""}
      ${ag.whats_hindering ? `<div class="glance-section"><strong>⚠️ 什么在阻碍你：</strong>${escHtml(ag.whats_hindering)} <a href="#section-friction" class="see-more">摩擦点分析 →</a></div>` : ""}
      ${ag.quick_wins ? `<div class="glance-section"><strong>⚡ 立即可以改进：</strong>${escHtml(ag.quick_wins)} <a href="#section-agents" class="see-more">AGENTS.md 建议 →</a></div>` : ""}
      ${ag.ambitious_workflows ? `<div class="glance-section"><strong>🚀 可以更进一步：</strong>${escHtml(ag.ambitious_workflows)} <a href="#section-horizon" class="see-more">展望 →</a></div>` : ""}
    </div>
  </div>` : ""

  // ── project_areas + interaction_style → portrait ──
  const projectAreasText = getSectionText("project_areas")
  const interactionText = getSectionText("interaction_style")
  const portraitHtml = (projectAreasText || interactionText) ? `
  <h2 id="section-portrait">使用画像</h2>
  <div class="narrative">
    ${markdownToHtml(projectAreasText)}
    ${markdownToHtml(interactionText)}
  </div>` : ""

  // ── charts ──
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
      ${[...allModels].map((m) => `<div style="font-size:12px;color:#475569;padding:4px 0;border-bottom:1px solid #f1f5f9">${escHtml(m)}</div>`).join("") || '<span class="empty">未记录</span>'}
    </div>
  </div>`

  // ── what_works ──
  let hlData = []
  const whatWorksText = getSectionText("what_works")
  if (whatWorksText) {
    try { hlData = parseJsonArray(whatWorksText) } catch (e) { process.stderr.write(`⚠️ what_works 解析失败: ${e.message}\n`) }
  }
  const highlightsHtml = hlData.length > 0 ? `
  <h2 id="section-highlights">工作流亮点</h2>
  <div class="big-wins">
    ${hlData.map((h) => `
    <div class="big-win">
      <div class="big-win-title">${escHtml(h.title ?? "")}</div>
      <div class="big-win-desc">${escHtml(h.description ?? "")}</div>
    </div>`).join("")}
  </div>` : ""

  // ── friction_analysis ──
  let frData = []
  const frictionText = getSectionText("friction_analysis")
  if (frictionText) {
    try { frData = parseJsonArray(frictionText) } catch (e) { process.stderr.write(`⚠️ friction_analysis 解析失败: ${e.message}\n`) }
  }
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

  // ── suggestions (AGENTS.md + features) ──
  let suggestionsData = null
  const suggestionsText = getSectionText("suggestions")
  if (suggestionsText) {
    try { suggestionsData = parseJson(suggestionsText) } catch (e) {
      process.stderr.write(`⚠️ suggestions 解析失败: ${e.message}\n`)
    }
  }

  const agMdData = suggestionsData?.agents_md_additions ?? []
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

  const featData = suggestionsData?.features_to_try ?? []
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

  // ── on_the_horizon ──
  const horizonText = getSectionText("on_the_horizon")
  const horizonHtml = horizonText ? `
  <h2 id="section-horizon">展望</h2>
  <div class="horizon-card">
    ${markdownToHtml(horizonText)}
  </div>` : ""

  // ── fun_ending ──
  let funData = null
  const funText = getSectionText("fun_ending")
  if (funText) {
    try { funData = parseJson(funText) } catch (e) {
      process.stderr.write(`⚠️ fun_ending 解析失败: ${e.message}\n`)
    }
  }
  const funHtml = funData?.headline ? `
  <div class="fun-ending">
    <div class="fun-headline">"${escHtml(funData.headline)}"</div>
    ${funData.detail ? `<div class="fun-detail">${escHtml(funData.detail)}</div>` : ""}
  </div>` : ""

  // ── session list ──
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

  const noLlmBanner = !API_CFG ? `<div class="no-llm-banner">⚠️ LLM 分析不可用（API 配置未找到），以下仅展示统计数据。</div>` : ""

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
  .no-llm-banner{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px;margin-bottom:24px;font-size:14px;color:#9a3412}
  @media(max-width:640px){.charts-row{grid-template-columns:1fr}.stats-row{justify-content:center}}
</style>
</head>
<body>
<div class="container">
  <h1>OpenCode Insights</h1>
  <p class="subtitle">${totalUserMsgs} 条消息，${summaries.length} 个会话，${activeDays} 个活跃天 | ${agg.date_range.start} — ${agg.date_range.end} | 生成于 ${new Date().toLocaleString("zh-CN")}</p>

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
  ${noLlmBanner}
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
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const rawSessions = db
  .prepare(`SELECT id, title, directory, time_created, time_updated,
                   summary_additions, summary_deletions, summary_files
            FROM session
            WHERE time_archived IS NULL AND time_created >= ?
            ORDER BY time_updated DESC`)
  .all(SINCE)

process.stderr.write(`分析最近 ${DAYS} 天的 ${rawSessions.length} 个会话（读取数据库）...\n`)
const summaries = rawSessions.map((s, i) => {
  if (i === 0 || (i + 1) % 20 === 0 || i === rawSessions.length - 1) {
    process.stderr.write(`  读取中 ${i + 1}/${rawSessions.length}...\n`)
  }
  return analyzeSession(s)
})

if (!API_CFG) {
  process.stderr.write("⚠️ 未找到 API 配置，仅生成统计报告（无 LLM 分析）\n")
  const agg = aggregateData(summaries, new Map())
  const html = generateHtml(summaries, agg, [], null)
  writeFileSync(REPORT_PATH, html)
  process.stderr.write(`\n✅ HTML 报告已保存至：${REPORT_PATH}\n`)
  process.exit(0)
}

// Phase 2: Facet extraction
const eligible = summaries.filter((s) => s.userMsgs >= 2 && s.durationMin >= 1 && !isMetaSession(s.id))
const uncached = eligible.filter((s) => {
  const p = join(FACETS_DIR, `${s.id}.json`)
  if (!existsSync(p)) return true
  try {
    const c = JSON.parse(readFileSync(p, "utf8"))
    return !c.ts || Date.now() - c.ts >= CACHE_TTL_MS
  } catch (_) { return true }
})

const toProcess = uncached.slice(0, 50)
if (toProcess.length > 0) {
  process.stderr.write(`提取 ${toProcess.length} 个 session facets（使用缓存：${eligible.length - toProcess.length} 个）...\n`)
  const tasks = toProcess.map((s) => async () => {
    const transcript = buildTranscript(s.id)
    try {
      await extractFacets(s.id, transcript)
      process.stderr.write(`  ✓ ${s.title?.slice(0, 40) ?? s.id}\n`)
    } catch (e) {
      process.stderr.write(`  ⚠️ 跳过 ${s.id}: ${e.message}\n`)
    }
  })
  await runWithConcurrency(tasks, 2)
} else {
  process.stderr.write(`使用缓存的 facets（${eligible.length} 个 session）\n`)
}

// Load all facets
const facetsMap = new Map()
for (const s of eligible) {
  const p = join(FACETS_DIR, `${s.id}.json`)
  if (existsSync(p)) {
    try { facetsMap.set(s.id, JSON.parse(readFileSync(p, "utf8")).data) } catch (e) {
      process.stderr.write(`⚠️ facet 缓存损坏 ${s.id}: ${e.message}\n`)
    }
  }
}

// Phase 3: Aggregate
const agg = aggregateData(summaries, facetsMap)
const dataContext = buildDataContext(agg)

// Phase 4: 7 parallel sections
process.stderr.write(`LLM 生成 7 个并行 section（${API_CFG.provider}/${API_CFG.model}）...\n`)

const sectionNames = ["project_areas", "interaction_style", "what_works", "friction_analysis", "suggestions", "on_the_horizon", "fun_ending"]
const sectionResults = await Promise.all(
  sectionNames.map((name) => generateSection(name, SECTION_PROMPTS[name](dataContext)))
)

// at_a_glance: uses all section outputs
const sectionOutputsContext = sectionResults.filter((s) => s.ok)
  .map((s) => `=== ${s.name.toUpperCase()} ===\n${s.text}`)
  .join("\n\n")

process.stderr.write(`LLM 生成 at_a_glance...\n`)
const atAGlancePrompt = `Based on the following analysis sections about a developer's OpenCode usage, generate a concise "At a Glance" summary.

${sectionOutputsContext}

Return a JSON object:
{
  "summary": "2-3 sentence overall summary of their usage patterns",
  "whats_working": "what's working well (1 sentence)",
  "whats_hindering": "main obstacle (1 sentence)",
  "quick_wins": "the most impactful immediate improvement (1 sentence)",
  "ambitious_workflows": "an ambitious workflow they could try based on their patterns (1 sentence)"
}

Return ONLY the JSON. Respond in Chinese.`

let atAGlance = null
try {
  atAGlance = await callLLM([{ role: "user", content: atAGlancePrompt }], 1024)
} catch (e) {
  process.stderr.write(`⚠️ at_a_glance 生成失败: ${e.message}\n`)
}

// Phase 5: HTML
const html = generateHtml(summaries, agg, sectionResults, atAGlance)
writeFileSync(REPORT_PATH, html)
process.stderr.write(`\n✅ HTML 报告已保存至：${REPORT_PATH}\n`)
process.stderr.write(`   open "${REPORT_PATH}"\n`)
