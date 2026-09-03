/** @jsxImportSource @opentui/solid */
// Compaction meter for the opencode TUI.
//
// Shows, for the open session, whether compaction is letting work happen or
// just spinning: compactions so far, tool calls per cycle, the room the
// current cycle started with, and whether the last summary was cut off.
// Rendered on the right of the prompt row and as a sidebar block, with a
// toast when a compaction completes.
//
// https://github.com/tannerbruhn/opencode-compaction-meter
// Loaded from tui.json:  "plugin": ["./tui-plugins/compaction-meter.tsx"]
// Options:  ["./tui-plugins/compaction-meter.tsx", { "badge": "\uf021" }]
//   badge   glyph in front of the count on narrow terminals (default "↻"; use
//           "◆" for fonts without the Arrows block, or "\uf021" with a Nerd Font)
import type { AssistantMessage, CompactionPart, Message, Part } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"

// A cycle that ends after fewer tool calls than this made little progress.
const THRASH_TOOLS = 5
// Warn when a cycle starts with less than this fraction of the usable window free.
const LOW_ROOM = 0.2
// The host sidebar is 42 columns with 2 of padding each side.
const LINE = 37

// opencode counts a compaction as done when the summary has a finish reason
// and no error. "length" means the summary hit the output cap.
function isSummary(m: Message): m is AssistantMessage {
  return m.role === "assistant" && m.summary === true && typeof m.finish === "string" && !m.error
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return "now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

function byId(a: { id: string }, b: { id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// The TUI store only syncs the newest 100 messages of a session. Fetch the
// full history (with parts, for tool counts) once per session and merge it
// with the live store, which wins for any message it has.
type History = { infos: Message[]; parts: Map<string, Part[]> }
const history = new Map<string, Accessor<History>>()

function loadHistory(api: TuiPluginApi, sessionID: string): Accessor<History> {
  const cached = history.get(sessionID)
  if (cached) return cached
  const [get, set] = createSignal<History>({ infos: [], parts: new Map() })
  history.set(sessionID, get)
  api.client.session
    .messages({ sessionID })
    .then((res) => {
      const infos: Message[] = []
      const parts = new Map<string, Part[]>()
      for (const m of res.data ?? []) {
        infos.push(m.info)
        parts.set(m.info.id, m.parts)
      }
      set({ infos, parts })
    })
    .catch(() => {})
  return get
}

function view(api: TuiPluginApi, sessionID: string) {
  const live = api.state.session.messages(sessionID)
  const liveIds = new Set(live.map((m) => m.id))
  const h = loadHistory(api, sessionID)()
  const map = new Map<string, Message>()
  for (const m of h.infos) map.set(m.id, m)
  for (const m of live) map.set(m.id, m)
  const msgs = [...map.values()].sort(byId)
  const parts = (id: string): ReadonlyArray<Part> => (liveIds.has(id) ? api.state.part(id) : (h.parts.get(id) ?? []))
  return { msgs, parts }
}

// Mirrors opencode's usable() in session/overflow.ts: the context size at
// which auto-compaction fires.
function usableWindow(api: TuiPluginApi, m: AssistantMessage): number | undefined {
  const model = api.state.provider.find((p) => p.id === m.providerID)?.models[m.modelID]
  if (!model?.limit?.context) return
  const output = model.limit.output || 0
  const cfg = (api.state.config as { compaction?: { reserved?: number } }).compaction
  const reserved = cfg?.reserved ?? Math.min(20_000, output)
  const input = (model.limit as { input?: number }).input
  return input ? Math.max(0, input - reserved) : Math.max(0, model.limit.context - output)
}

type Cycle = { tools: number; truncated: boolean }
type Stat = {
  count: number
  cycles: Cycle[] // completed cycles, oldest first; truncated = the summary that closed it was cut off
  now: number // tool calls since the last compaction
  last?: { id: string; at: number; summary: number; truncated: boolean; auto: boolean; overflow: boolean }
  restart?: number // prompt size of the first turn after the last compaction
  usable?: number
  thrash: boolean
  lowRoom: boolean
}

function analyse(api: TuiPluginApi, sessionID: string): Stat {
  const { msgs, parts } = view(api, sessionID)
  const cycles: Cycle[] = []
  let tools = 0
  let last: AssistantMessage | undefined
  let lastIndex = -1
  let latest: AssistantMessage | undefined
  msgs.forEach((m, i) => {
    if (isSummary(m)) {
      cycles.push({ tools, truncated: m.finish === "length" })
      tools = 0
      last = m
      lastIndex = i
      return
    }
    if (m.role !== "assistant") return
    latest = m
    tools += parts(m.id).filter((p) => p.type === "tool").length
  })
  if (!last) return { count: 0, cycles, now: tools, thrash: false, lowRoom: false }
  const req = parts(last.parentID).find((p): p is CompactionPart => p.type === "compaction")
  const first = msgs
    .slice(lastIndex + 1)
    .find((m): m is AssistantMessage => m.role === "assistant" && !m.summary && m.tokens.output > 0)
  const restart = first ? first.tokens.input + first.tokens.cache.read + first.tokens.cache.write : undefined
  const usable = usableWindow(api, latest ?? last)
  const recent = cycles.slice(-2)
  const thrash = recent.length === 2 && recent.every((c) => c.tools < THRASH_TOOLS)
  const lowRoom = restart !== undefined && !!usable && (usable - restart) / usable < LOW_ROOM
  return {
    count: cycles.length,
    cycles,
    now: tools,
    last: {
      id: last.id,
      at: last.time.completed ?? last.time.created,
      summary: last.tokens.output,
      truncated: last.finish === "length",
      auto: req?.auto ?? true,
      overflow: req?.overflow ?? false,
    },
    restart,
    usable,
    thrash,
    lowRoom,
  }
}

function room(s: Stat): number | undefined {
  if (s.restart === undefined || !s.usable) return
  return Math.max(0, s.usable - s.restart)
}

// Prompt row, right side. Shrinks with the terminal so it never wraps:
//   >= 120 cols  "compact 3! · 5 tools · 59k room"   (sidebar visible too)
//   80-119 cols  "compact 3! · 59k"
//   < 80 cols    "↻3!"                                (phone over tmux; badge is configurable)
function Inline(props: { api: TuiPluginApi; session_id: string; badge: string }) {
  const theme = () => props.api.theme.current
  const dim = useTerminalDimensions()
  const s = createMemo(() => analyse(props.api, props.session_id))
  const warn = () => s().thrash || s().lowRoom
  const parts = createMemo(() => {
    const st = s()
    const w = dim().width
    const r = room(st)
    if (w < 80) return { head: props.badge, tail: "" }
    if (w < 120) return { head: "compact ", tail: r !== undefined ? ` · ${fmt(r)}` : "" }
    return { head: "compact ", tail: ` · ${st.now} tools${r !== undefined ? ` · ${fmt(r)} room` : ""}` }
  })
  return (
    <Show when={s().count > 0}>
      <text fg={warn() ? theme().warning : theme().textMuted} wrapMode="none">
        {parts().head}
        <span style={{ fg: warn() ? theme().warning : theme().text }}>{s().count}</span>
        <span style={{ fg: theme().error }}>{s().last?.truncated ? "!" : ""}</span>
        {parts().tail}
      </text>
    </Show>
  )
}

// "tools/cycle … 4! 3 5 3 17 2 · now 13": as many recent cycles as fit on
// one sidebar line, newest on the right, "…" when older ones were cut.
function cycleLine(s: Stat): string {
  const head = "tools/cycle "
  const tail = ` · now ${s.now}`
  const budget = LINE - head.length - tail.length
  const tokens = s.cycles.map((c) => `${c.tools}${c.truncated ? "!" : ""}`)
  const shown: string[] = []
  let len = 0
  for (let i = tokens.length - 1; i >= 0; i--) {
    const add = tokens[i].length + (shown.length ? 1 : 0)
    const reserve = i > 0 ? 2 : 0 // keep room for "… " if older cycles get cut
    if (len + add + reserve > budget) break
    shown.unshift(tokens[i])
    len += add
  }
  const cut = shown.length < tokens.length
  return `${head}${cut ? "… " : ""}${shown.join(" ")}${tail}`
}

// Sidebar block, below the built-in Context block.
function Block(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const s = createMemo(() => analyse(props.api, props.session_id))
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))

  const trigger = () => (s().last?.overflow ? " · overflow" : s().last?.auto === false ? " · manual" : "")
  const restart = () => {
    const st = s()
    if (st.restart === undefined) return "restart pending"
    if (!st.usable) return `restart ${st.restart.toLocaleString()}`
    const pct = Math.round(((st.usable - st.restart) / st.usable) * 100)
    return `restart ${st.restart.toLocaleString()} / ${fmt(st.usable)} · ${pct}% room`
  }

  return (
    <Show when={s().count > 0}>
      <box>
        <text fg={theme().text}>
          <b>Compaction</b>
        </text>
        <text fg={theme().textMuted}>
          {s().count} {s().count === 1 ? "compaction" : "compactions"} · {ago(s().last!.at, now())}
          {trigger()}
        </text>
        <text fg={s().thrash ? theme().warning : theme().textMuted}>{cycleLine(s())}</text>
        <text fg={s().lowRoom ? theme().warning : theme().textMuted}>{restart()}</text>
        <text fg={theme().textMuted}>
          summary {s().last!.summary.toLocaleString()}
          <span style={{ fg: theme().error }}>{s().last!.truncated ? " !" : ""}</span>
        </text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const badge = typeof options?.badge === "string" && options.badge ? options.badge : "↻"
  api.slots.register({
    order: 150,
    slots: {
      session_prompt_right(_ctx, props) {
        return <Inline api={api} session_id={props.session_id} badge={badge} />
      },
      sidebar_content(_ctx, props) {
        return <Block api={api} session_id={props.session_id} />
      },
    },
  })

  // Toast once per newly completed compaction. Summaries that completed
  // before this TUI started are history being loaded, not live events.
  const started = Date.now()
  const seen = new Set<string>()
  api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (!isSummary(info) || seen.has(info.id)) return
    seen.add(info.id)
    if ((info.time.completed ?? 0) < started) return
    // Give the sync store a moment to apply the same event before reading it.
    setTimeout(() => {
      const s = analyse(api, info.sessionID)
      const cycle = s.cycles[s.cycles.length - 1]
      const cut = info.finish === "length" ? " !" : ""
      api.ui.toast({
        variant: s.thrash ? "warning" : "info",
        title: s.thrash ? "Compaction thrash" : "Compacted",
        message: `#${s.count} · ${cycle?.tools ?? 0} tools this cycle · summary ${fmt(info.tokens.output)}${cut}`,
        duration: 6000,
      })
    }, 300)
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "compaction-meter",
  tui,
}

export default plugin
