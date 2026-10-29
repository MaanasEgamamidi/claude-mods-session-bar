import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, SessionRateLimit, ToolUseSummary, UiPressArgument } from 'claude-code'

import type { Agents, Codex, Git, Limit, Recent, Stats, Suggest } from '../types'

// Claude Code caches prompts for an hour; usage overage drops that to five minutes.
const CACHE_TTL_MS = 60 * 60 * 1000

const stats = atom({ plugin: 'session-cost', key: 'stats' } as const, { limits: [] } as Stats)
// The current minute, rewritten by a timer so the time-based parts redraw as it moves.
const tick = atom({ plugin: 'session-cost', key: 'tick' } as const, 0)
const agents = atom({ plugin: 'session-cost', key: 'agents' } as const, { running: [], finished: 0 } as Agents)
const recent = atom({ plugin: 'session-cost', key: 'recent' } as const, { prompts: [], replies: [] } as Recent)
const suggest = atom({ plugin: 'session-cost', key: 'suggest' } as const, { given: [] } as Suggest)
const git = atom({ plugin: 'session-cost', key: 'git' } as const, { changed: 0, isBusy: false } as Git)
const codex = atom({ plugin: 'session-cost', key: 'codex' } as const, { isOn: false } as Codex)

export const format = (value: number) => `$${value.toFixed(2)}`

const toLimits = (limits: readonly SessionRateLimit[]): Limit[] =>
  limits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))

export const cacheMinutesLeft = (lastResponseAt: number | undefined, now: number) =>
  lastResponseAt === undefined ? undefined : Math.max(0, Math.ceil((lastResponseAt + CACHE_TTL_MS - now) / 60000))

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
// Too little of the window has passed to judge before this share of it; projections swing wildly.
const MIN_ELAPSED_SHARE = 1 / 60
// Projected use at reset below this share of the limit leaves a lot unused.
const SLOW_BELOW = 70

// How a window is going: the use so far, run on at the same rate to the reset.
// Over 100% means the limit is hit before the window resets.
export const pace = (limit: Limit, now: number, windowMs = FIVE_HOURS_MS) => {
  const used = limit.percentUsed
  if (used >= 100) return 'Limit Hit'
  if (limit.resetsAt === undefined) return undefined
  const resetsAt = Date.parse(limit.resetsAt)
  if (Number.isNaN(resetsAt)) return undefined
  const elapsed = Math.min(windowMs, Math.max(0, now - (resetsAt - windowMs)))
  if (elapsed < windowMs * MIN_ELAPSED_SHARE) return undefined

  const projected = (used / elapsed) * windowMs
  if (projected > 100) return 'Too Fast'

  return projected < SLOW_BELOW ? 'Too Slow' : 'Good Speed'
}

// The 5-hour window when the engine reports one, else the weekly one.
export const paceWindow = (limits: readonly Limit[]) => {
  const fiveHour = limits.find(limit => limit.kind === 'five_hour')
  if (fiveHour !== undefined) return { limit: fiveHour, windowMs: FIVE_HOURS_MS, name: '5-hour' }
  const sevenDay = limits.find(limit => limit.kind === 'seven_day')
  if (sevenDay !== undefined) return { limit: sevenDay, windowMs: SEVEN_DAYS_MS, name: '7-day' }

  return undefined
}

// The pace's hover line: what the verdict is read from, or why there is none yet.
export const describePaceSource = (limits: readonly Limit[], now: number) => {
  const w = paceWindow(limits)
  if (w === undefined) return 'No rate-limit reading from the engine yet: it arrives with a response'
  const resets = w.limit.resetsAt === undefined ? Number.NaN : Date.parse(w.limit.resetsAt)
  const minutes = Number.isNaN(resets) ? undefined : Math.max(0, Math.round((resets - now) / 60000))
  const left = minutes === undefined ? '' : minutes >= 120 ? `, resets in ${Math.round(minutes / 60)}h` : `, resets in ${minutes}m`

  return `${w.name} window: ${w.limit.percentUsed}% used${left}`
}

export const describeAgents = ({ running, finished }: Agents) => {
  const plural = (n: number) => (n === 1 ? 'subagent' : 'subagents')
  if (running.length > 0 && finished > 0) return `${running.length} ${plural(running.length)} running, ${finished} finished`
  if (running.length > 0) return `${running.length} ${plural(running.length)} running`
  if (finished > 0) return `${finished} ${plural(finished)} finished`

  return undefined
}

const joinParts = (parts: (string | undefined)[]) =>
  parts.filter((part): part is string => part !== undefined).join('  ·  ')

// The cache countdown on its own, so the bar can hang the rewake cost on it.
export const describeCache = (s: Stats, now: number) => {
  const left = cacheMinutesLeft(s.lastResponseAt, now)
  if (left === undefined) return undefined

  return left > 0 ? `Cache warm · ${left}m left` : 'Cache expired'
}

// The pace and the subagents, everything after the cache; empty when there is none.
export const describeRest = (s: Stats, now: number, a: Agents = { running: [], finished: 0 }) => {
  const w = paceWindow(s.limits)
  const verdict = w === undefined ? undefined : pace(w.limit, now, w.windowMs)

  return joinParts([verdict, describeAgents(a)])
}

// The bar's text: the parts on the left, the cost on the right.
export const describe = (s: Stats, now: number, a: Agents = { running: [], finished: 0 }) => {
  const rest = describeRest(s, now, a)

  return {
    left: joinParts([describeCache(s, now), rest === '' ? undefined : rest]),
    right: s.usd === undefined ? undefined : `Session ${format(s.usd)}`,
  }
}

// ---- Layout --------------------------------------------------------------------

// The band lays itself out to the width it is given, like a responsive page: each row keeps its
// full labels while they fit on one line, switches to short ones when they don't, and wraps whole
// items onto the next line past that, so no phrase is split and nothing is clipped at the edge.

// Cells a Button takes beyond its label: its padding and border.
const BUTTON_CHROME = 4
const STATUS_GAP = 2
const BUTTON_GAP = 1
// The status row's padding at each side.
const EDGE = 1

export const describeCacheShort = (s: Stats, now: number) => {
  const left = cacheMinutesLeft(s.lastResponseAt, now)
  if (left === undefined) return undefined

  return left > 0 ? `Cache ${left}m` : 'Cache cold'
}

export const describeAgentsShort = ({ running, finished }: Agents) => {
  if (running.length > 0 && finished > 0) return `${running.length} running, ${finished} done`
  if (running.length > 0) return `${running.length} running`
  if (finished > 0) return `${finished} done`

  return undefined
}

const defined = <T,>(list: readonly (T | undefined)[]) => list.filter((item): item is T => item !== undefined)

// The status row on one line: its parts, the gaps between them and its padding.
export const statusWidth = (parts: readonly (string | undefined)[]) => {
  const shown = defined(parts)

  return shown.reduce((n, part) => n + part.length, 0) + STATUS_GAP * Math.max(0, shown.length - 1) + 2 * EDGE
}

export type ButtonLabels = { suggest: string; rebuild: string; handoff: string; codex: string; commit?: string; cost?: string }

// The button row on one line: each button with its chrome, the gaps, and the cost at the end.
export const buttonsWidth = ({ cost, ...buttons }: ButtonLabels) => {
  const labels = defined(Object.values(buttons))

  return labels.reduce((n, label) => n + label.length + BUTTON_CHROME, 0) + BUTTON_GAP * (labels.length - 1) + (cost === undefined ? 0 : STATUS_GAP + cost.length) + EDGE
}

// The first option that fits in `columns` on one line, else the last and shortest; the row wraps past that.
export const pickFit = <T,>(columns: number, options: readonly [T, ...T[]], width: (option: T) => number) =>
  options.find(option => width(option) <= columns) ?? options[options.length - 1]!

export const buttonLabels = (
  isShort: boolean,
  { busy, codexOn, changed, committing, usd }: { busy: Suggest['busy']; codexOn: boolean; changed: number; committing: boolean; usd: number | undefined },
): ButtonLabels => ({
  suggest: busy === 'suggest' ? 'Thinking…' : isShort ? '✦ Suggest' : '✦ Suggest a feature',
  rebuild: busy === 'rebuild' ? 'Rebuilding…' : isShort ? '✎ Rebuild' : '✎ Rebuild Prompt',
  handoff: busy === 'handoff' ? 'Summarizing…' : '⧉ Handoff',
  codex: codexOn ? (isShort ? '◉ Codex' : '◉ Codex on') : '○ Codex',
  commit: committing ? 'Committing…' : changed === 0 ? undefined : isShort ? `⇪ Commit ${changed}` : `⇪ Commit ${changed} file${changed === 1 ? '' : 's'}`,
  cost: usd === undefined ? undefined : isShort ? format(usd) : `Session ${format(usd)}`,
})

// Rows a text takes when word-wrapped at `width` cells.
export const wrapRows = (text: string, width: number) => {
  let rows = 1
  let line = 0
  for (const word of text.split(' ')) {
    if (line === 0) line = word.length
    else if (line + 1 + word.length <= width) line += 1 + word.length
    else {
      rows += 1
      line = word.length
    }
    for (; line > width; line -= width) rows += 1
  }

  return rows
}

// A hover card over a status part `x` cells into the band: as wide as its longest line or the band,
// slid left so it stays inside, and raised by the rows its lines wrap to so it sits above the part.
export const hoverCard = (lines: readonly string[], x: number, columns: number) => {
  const width = Math.min(Math.max(...lines.map(line => line.length)) + 4, Math.max(12, columns - 2 * EDGE))
  const rows = lines.reduce((n, line) => n + wrapRows(line, width - 4), 0)

  return { width, top: -(rows + 1), left: Math.min(0, columns - EDGE - x - width) }
}

// Re-caching the context on restart is a cache write, billed at the one-hour rate: twice the input price.
const CACHE_WRITE_MULTIPLE = 2

// Input dollars per million tokens for a model id; undefined for a model this does not price.
export const inputUsdPerMTok = (model: string) => {
  const id = model.toLowerCase()
  if (id.includes('fable')) return 10
  if (id.includes('opus-5-5') || id.includes('opus-5.5')) return 4
  if (id.includes('opus')) return 5
  if (id.includes('sonnet-4')) return 3
  if (id.includes('sonnet')) return 2
  if (id.includes('haiku-5')) return 0.1
  if (id.includes('haiku')) return 1

  return undefined
}

// What re-caching `contextTokens` costs at `usdPerMTok` input pricing.
export const rewakeUsd = (contextTokens: number, usdPerMTok: number) =>
  (contextTokens * CACHE_WRITE_MULTIPLE * usdPerMTok) / 1_000_000

// Before the cost or the limits have landed (a fresh load, a measure without limits), ask the engine directly.
const current = async ($: EngineInterface): Promise<Stats> => {
  const s = await read($, stats)
  if (s.usd !== undefined && s.limits.length > 0) return s
  const usage = await $.session.usage()

  return {
    ...s,
    usd: s.usd ?? usage.cost?.usd,
    contextPercent: s.contextPercent ?? usage.context.percent,
    contextTokens: s.contextTokens ?? usage.context.tokens,
    limits: s.limits.length > 0 ? s.limits : toLimits(usage.rateLimits),
  }
}

// What the suggest button reads: a few of the latest messages, each cut short, never code or diffs.
const KEEP = 3
const CLIP = 1500
const keepLast = (list: readonly string[], text: string) => [...list, text.trim().slice(0, CLIP)].slice(-KEEP)

const SUGGEST_SYSTEM = [
  'You suggest what to build next in a coding session.',
  'From the recent messages, propose ONE new feature the user could ask for next, written as a prompt in their own voice:',
  'one or two sentences, under 40 words, ready to send to a coding assistant.',
  'It must fit what they are building, be new (not already done, not already suggested) and be concrete.',
  'Reply with the prompt text only: no quotes, no preamble, no list.',
].join(' ')

export const suggestionPrompt = (r: Recent, given: readonly string[]) =>
  [
    'Recent prompts from the user (oldest first):',
    ...r.prompts.map(p => `- ${p}`),
    '',
    'Recent replies from the assistant (oldest first):',
    ...r.replies.map(p => `---\n${p}`),
    ...(given.length > 0 ? ['', 'Already suggested; pick something different:', ...given.map(g => `- ${g}`)] : []),
  ].join('\n')

export const cleanSuggestion = (text: string) => text.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()

const REBUILD_SYSTEM = [
  "You rewrite a user's rough draft prompt for a coding assistant into a clear, well-structured prompt.",
  'Keep their intent and every requirement and detail they gave; do not add features or requirements they did not ask for.',
  'Fix spelling and grammar, remove repetition, and resolve vague references using the recent conversation.',
  'Start with one sentence stating the goal; if there are several requirements or constraints, list them after as short "- " bullets.',
  "Write in the user's voice. Reply with the rewritten prompt only: no preamble, no quotes, no headings.",
].join(' ')

export const rebuildPrompt = (r: Recent, draft: string) =>
  [
    'Recent prompts from the user (oldest first):',
    ...r.prompts.map(p => `- ${p}`),
    '',
    'Recent replies from the assistant (oldest first):',
    ...r.replies.map(p => `---\n${p}`),
    '',
    'The draft to rewrite:',
    draft.trim(),
  ].join('\n')

// One Haiku call at low effort, as asked; a model that takes no effort setting gets the plain call.
const askHaiku = async ($: EngineInterface, system: string, prompt: string, maxTokens: number, model = 'haiku') => {
  const ask = { model, system, prompt, maxTokens }
  const reply = await $.model.complete({ ...ask, effort: 'low' }).catch(() => $.model.complete(ask))

  return reply.isAnswered ? { text: cleanSuggestion(reply.text) } : { text: '', reason: reply.reason }
}

// Runs one button's model call, marking it busy so the label says so and a second press waits.
const withBusy = async ($: EngineInterface, which: NonNullable<Suggest['busy']>, work: () => Promise<void>) => {
  if ((await read($, suggest)).busy !== undefined) return
  await update($, suggest, s => ({ ...s, busy: which }))
  try {
    await work()
  } finally {
    await update($, suggest, s => ({ ...s, busy: undefined }))
  }
}

const suggestFeature = async ($: EngineInterface) => {
  const r = await read($, recent)
  if (r.prompts.length === 0 && r.replies.length === 0) {
    $.ui.toast('Send a message first, so there is something to suggest from')
    return
  }

  await withBusy($, 'suggest', async () => {
    const { given } = await read($, suggest)
    const { text, reason } = await askHaiku($, SUGGEST_SYSTEM, suggestionPrompt(r, given), 200)
    if (text === '') {
      $.ui.toast(`No suggestion this time${reason === undefined ? '' : ` (${reason})`}`)
      return
    }

    await $.prompt.fill({ text, mode: 'replace' })
    await update($, suggest, s => ({ ...s, given: [...s.given, text].slice(-10) }))
  })
}

const rebuildDraft = async ($: EngineInterface) => {
  const draft = (await $.prompt.read()).text
  if (draft.trim() === '') {
    $.ui.toast('Type a rough prompt first, then Rebuild Prompt tidies it up')
    return
  }

  await withBusy($, 'rebuild', async () => {
    const { text, reason } = await askHaiku($, REBUILD_SYSTEM, rebuildPrompt(await read($, recent), draft), 800)
    if (text === '') {
      $.ui.toast(`Couldn't rebuild the prompt${reason === undefined ? '' : ` (${reason})`}`)
      return
    }

    // The draft may have changed while the model wrote; only replace the one that was sent off.
    if ((await $.prompt.read()).text !== draft) {
      $.ui.toast('The draft changed while rebuilding, so it was left as you typed it')
      return
    }
    await $.prompt.fill({ text, mode: 'replace' })
  })
}

// ---- Handoff -------------------------------------------------------------------

const HANDOFF_MODEL = 'claude-haiku-5-5'
// How much of the transcript Haiku reads: every prompt and reply clipped, the newest kept when it runs over.
const HANDOFF_CLIP = 80_000
const PROMPT_CLIP = 3000
const REPLY_CLIP = 1500

const HANDOFF_SYSTEM = [
  'You write a handoff note so the user can continue this coding session in a fresh chat with a new assistant that has no memory of it.',
  'From the transcript, write Markdown with exactly these sections:',
  '"## Goal" (one or two sentences: what the user is building or trying to do);',
  '"## What I asked for" (bullets, one per request, oldest first);',
  '"## What was done" (bullets: changes made, files touched with their paths, decisions and why, findings, commands that matter);',
  '"## Current state" (what works, and what is unfinished, unverified or broken);',
  '"## Next steps" (concrete bullets, most important first).',
  'Write in the user\'s voice ("I asked…", "you (the previous assistant) added…"). Keep exact names, paths, ids and error messages.',
  'Use only facts from the transcript; do not invent. Stay under 450 words.',
  'Start with the line "Context from my previous Claude Code session:" and reply with the note only.',
].join(' ')

// The engine's own notes in a user message (reminders, hook output) are not what the person typed.
const stripNotes = (text: string) => text.replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, '').trim()

const oneLine = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max)

// A tool call as one short clause: its name and what it touched.
export const describeToolUse = (use: ToolUseSummary) => {
  const target = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'].map(key => use.input[key]).find(v => typeof v === 'string')
  return `${use.tool}${typeof target === 'string' ? ` ${oneLine(target, 140)}` : ''}${use.isError ? ' (failed)' : ''}`
}

// The session as plain lines for Haiku: prompts, replies and tool calls, the first prompt always kept.
export const handoffTranscript = (messages: readonly SessionMessage[], budget = HANDOFF_CLIP) => {
  const lines: string[] = []
  for (const m of messages) {
    const text = m.role === 'user' ? stripNotes(m.text) : m.text.trim()
    if (m.role === 'user') {
      if (text !== '') lines.push(`USER: ${text.slice(0, PROMPT_CLIP)}`)
      continue
    }
    if (text !== '') lines.push(`CLAUDE: ${text.slice(0, REPLY_CLIP)}`)
    if (m.toolUses.length > 0) lines.push(`CLAUDE RAN: ${m.toolUses.map(describeToolUse).join('; ')}`)
  }

  const first = lines.findIndex(line => line.startsWith('USER: '))
  const head = first === -1 ? [] : [lines[first]!]
  const kept: string[] = []
  let size = head.reduce((n, line) => n + line.length + 1, 0)
  for (let i = lines.length - 1; i > first; i--) {
    size += lines[i]!.length + 1
    if (size > budget) break
    kept.unshift(lines[i]!)
  }
  const dropped = lines.length - head.length - kept.length

  return [...head, ...(dropped > 0 ? [`[… ${dropped} earlier lines left out …]`] : []), ...kept].join('\n')
}

const copyHandoff = async ($: EngineInterface, press: UiPressArgument) => {
  const transcript = handoffTranscript(await $.session.messages())
  if (!transcript.includes('USER: ')) {
    $.ui.toast('Send a message first, so there is something to hand off')
    return
  }

  await withBusy($, 'handoff', async () => {
    const { text, reason } = await askHaiku($, HANDOFF_SYSTEM, `The session transcript:\n\n${transcript}`, 1500, HANDOFF_MODEL)
    if (text === '') {
      $.ui.toast(`Couldn't write the handoff${reason === undefined ? '' : ` (${reason})`}`)
      return
    }

    const copied = await $.ui.copy({ text, surface: press.surface })
    $.ui.toast(copied.isCopied ? 'Handoff copied: paste it into a new chat' : `Couldn't copy the handoff (${copied.reason})`)
  })
}

// ---- Codex ---------------------------------------------------------------------

// Read by the model beside each prompt while the toggle is on; the person never sees it.
export const codexInstructions = (cwd: string) =>
  [
    'CODEX MODE is on: the user switched it on in the session bar. Do not do this task yourself.',
    'Hand it to the OpenAI Codex CLI, check what comes back, and report it.',
    '',
    '1. Write the user\'s prompt to a temp file, with any context Codex needs from this conversation',
    '   (files, decisions, earlier results). Codex has no memory of this chat.',
    `2. Run Codex in the session folder: codex exec --cd "${cwd}" --sandbox workspace-write --skip-git-repo-check -o "<temp>/codex-reply.md" - < "<temp>/codex-prompt.md" > "<temp>/codex.log" 2>&1`,
    '   Give the Bash call a 10-minute timeout, or run it in the background for a long task.',
    '   If an earlier Codex mode turn in this conversation ended with "Codex session: <id>", continue that',
    '   session instead: codex exec resume <id> -o "<temp>/codex-reply.md" - < "<temp>/codex-prompt.md".',
    '   Pass -m <model> only when the task calls for a different model than the user\'s default; pass -i <file>',
    '   for images the user attached. Codex can generate images, search the web and run its own subagents.',
    '3. Read codex-reply.md and check the work: look at the diff, run the tests or the code.',
    '   If it is wrong or incomplete, resume the same Codex session with specific feedback, at most two more times.',
    '   Fix a small leftover problem yourself only when Codex could not.',
    '4. Tell the user what Codex did and found, saying it came from Codex, and anything you changed after it.',
    '   End with the line "Codex session: <id>", the id from the "session id:" line in codex.log.',
    '',
    'If Codex is not installed or not signed in, say so and stop; do the task yourself only if the user asks.',
  ].join('\n')

// Only what the person sends: not slash commands, the engine's own prompts, notifications or plugins.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

const toggleCodex = async ($: EngineInterface) => {
  const { isOn } = await update($, codex, c => ({ isOn: !c.isOn }))
  $.ui.toast(isOn ? 'Codex mode on: your prompts go to the Codex CLI' : 'Codex mode off: back to Claude')
}

// ---- Commit --------------------------------------------------------------------

const COMMIT_SYSTEM = [
  'Write a git commit message for the changes below.',
  'First line: a short imperative subject, at most 60 characters, no trailing period.',
  'Then one blank line, then one to three short lines saying what changed and why.',
  'No trailers, no Co-Authored-By or sign-off lines, no attribution, no quotes, no markdown fences.',
].join(' ')

const DIFF_CLIP = 12_000

// Haiku's reply as a subject and body, with any trailer or attribution line it added anyway dropped.
export const parseCommitMessage = (text: string, files: number) => {
  const lines = text
    .replace(/```[a-z]*\n?/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => !/^(co-authored-by|signed-off-by):/i.test(line.trim()) && !/generated with/i.test(line))
  const at = lines.findIndex(line => line.trim() !== '')
  const subject = at === -1 ? '' : cleanSuggestion(lines[at]!).slice(0, 72)
  const body = at === -1 ? '' : lines.slice(at + 1).join('\n').trim()

  return { subject: subject === '' ? `Update ${files} file${files === 1 ? '' : 's'}` : subject, body }
}

// How many files differ from the last commit, untracked ones included; 0 outside a git repository.
const refreshGit = async ($: EngineInterface) => {
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd: await $.session.cwd() }).catch(() => undefined)
  const changed = status === undefined || status.exitCode !== 0 ? 0 : status.stdout.split('\n').filter(line => line.trim() !== '').length
  const { changed: was } = await read($, git)
  if (changed !== was) await update($, git, g => ({ ...g, changed }))
}

const commitChanges = async ($: EngineInterface) => {
  if ((await read($, git)).isBusy) return
  await update($, git, g => ({ ...g, isBusy: true }))
  try {
    const cwd = await $.session.cwd()
    const run = (argv: string[], stdin?: string) => $.process.run(['git', ...argv], { cwd, stdin, timeoutMs: 60_000 })

    // What changed since the last commit; a repository with no commit yet diffs the working tree.
    let diff = await run(['diff', 'HEAD'])
    if (diff.exitCode !== 0) diff = await run(['diff'])
    const stat = await run(['diff', 'HEAD', '--stat'])
    const untracked = (await run(['ls-files', '--others', '--exclude-standard'])).stdout.trim()
    const files = (await run(['status', '--porcelain'])).stdout.split('\n').filter(line => line.trim() !== '').length
    if (files === 0) {
      $.ui.toast('Nothing to commit')
      return
    }

    const prompt = [
      'Changed files:',
      stat.exitCode === 0 ? stat.stdout.trim() : '',
      untracked === '' ? '' : `New files:\n${untracked}`,
      '',
      'Diff:',
      diff.stdout.slice(0, DIFF_CLIP),
    ].join('\n')
    const { text } = await askHaiku($, COMMIT_SYSTEM, prompt, 300)
    const { subject, body } = parseCommitMessage(text, files)

    const added = await run(['add', '-A'])
    if (added.exitCode !== 0) {
      $.ui.toast(`git add failed: ${added.stderr.trim().split('\n')[0] ?? ''}`)
      return
    }
    // Authored by the person's own git identity; the message carries no trailers.
    const committed = await run(['commit', '-F', '-'], body === '' ? subject : `${subject}\n\n${body}`)
    if (committed.exitCode !== 0) {
      $.ui.toast(`Commit failed: ${(committed.stderr || committed.stdout).trim().split('\n')[0] ?? ''}`)
      return
    }
    const sha = (await run(['rev-parse', '--short', 'HEAD'])).stdout.trim()
    $.ui.toast(`Committed ${sha}: ${subject}`)
  } finally {
    await update($, git, g => ({ ...g, isBusy: false }))
    await refreshGit($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, stats, s => ({
      ...s,
      usd: usage.cost?.usd ?? s.usd,
      contextPercent: usage.context.percent ?? s.contextPercent,
      limits: usage.rateLimits.length > 0 ? toLimits(usage.rateLimits) : s.limits,
    }))

    // Redraw once a minute so the cache countdown and the pace follow the clock; a reload drops the old timer.
    $.clock.every(15000, async () => {
      const minute = Math.floor((await $.clock.now()) / 60000)
      if (minute !== (await read($, tick))) await update($, tick, () => minute)
    })
    // The Commit button shows while the folder has changes; edits made outside a turn show within ten seconds.
    await refreshGit($)
    $.clock.every(10_000, () => refreshGit($))

    return result
  })

  // Pushed by the engine whenever cost, context or limits move, including mid-turn.
  // Cost grows with every response, and every response refreshes the prompt cache.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, stats, s => ({
      usd: e.cost?.usd ?? s.usd,
      contextPercent: e.context.percent ?? s.contextPercent,
      contextTokens: e.context.tokens ?? s.contextTokens,
      limits: e.rateLimits.length > 0 ? toLimits(e.rateLimits) : s.limits,
      lastResponseAt: e.changed.includes('cost') ? now : s.lastResponseAt,
    }))

    return next(e)
  })

  // A subagent's run starts and ends as a turn of its own loop; the main loop's turns carry the conversation.
  on('turn.start', async ($, e, next) => {
    const { agentId, text } = e
    if (agentId !== undefined) {
      await update($, agents, a => (a.running.includes(agentId) ? a : { ...a, running: [...a.running, agentId] }))
    } else if (text.trim() !== '') {
      await update($, recent, r => ({ ...r, prompts: keepLast(r.prompts, text) }))
    }

    return next(e)
  })

  // Codex mode: the prompt goes on as typed, with the hand-off instructions beside it.
  // A failure here sends the prompt on unchanged rather than holding it up.
  on('prompt.submit', async ($, e, next) => {
    // An origin the engine left unstamped counts as the person's.
    const kind: string | undefined = e.origin?.kind
    if (e.command !== undefined || e.isMeta || (kind !== undefined && !PERSON_ORIGINS.has(kind))) return next(e)
    const instructions = await (async () => ((await read($, codex)).isOn ? codexInstructions(await $.session.cwd()) : undefined))().catch(() => undefined)
    if (instructions === undefined) return next(e)

    return next({ ...e, context: [...(e.context ?? []), instructions] })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const { agentId } = e
    if (agentId !== undefined) {
      await update($, agents, a =>
        a.running.includes(agentId) ? { running: a.running.filter(id => id !== agentId), finished: a.finished + 1 } : a,
      )
    } else {
      if (result.text.trim() !== '') await update($, recent, r => ({ ...r, replies: keepLast(r.replies, result.text) }))
      await refreshGit($)
    }

    return result
  })

  // Desktop and other surfaces: a row right above the prompt, the cost flush right over the model picker.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    await read($, tick)
    const s = await current($)
    const now = await $.clock.now()
    const a = await read($, agents)
    const w = paceWindow(s.limits)
    const verdict = w === undefined ? undefined : pace(w.limit, now, w.windowMs)
    const paceText = verdict === undefined ? 'Pace: measuring…' : `Pace: ${verdict}`
    const paceSource = describePaceSource(s.limits, now)
    const { busy } = await read($, suggest)
    const repo = await read($, git)
    const { isOn: codexOn } = await read($, codex)

    // The band's own width; a surface that has not measured gets the full labels, wrapping as needed.
    const columns = e.props.bodyColumns || e.viewport?.columns || Number.POSITIVE_INFINITY
    const [cache, , agentsText] = pickFit(
      columns,
      [
        [describeCache(s, now), paceText, describeAgents(a)],
        [describeCacheShort(s, now), paceText, describeAgentsShort(a)],
      ],
      statusWidth,
    )
    const label = pickFit(
      columns,
      [false, true].map(isShort => buttonLabels(isShort, { busy, codexOn, changed: repo.changed, committing: repo.isBusy, usd: s.usd })) as [ButtonLabels, ButtonLabels],
      buttonsWidth,
    )

    const rate = inputUsdPerMTok(await $.session.model())
    const rewake =
      rate === undefined ? 'Rewake cost unknown for this model' : s.contextTokens === undefined ? 'Rewake cost after the first response' : `Rewake cost ≈ ${format(rewakeUsd(s.contextTokens, rate))}`
    const detail = s.contextTokens === undefined ? '' : `Re-caches ${Math.round(s.contextTokens / 1000)}k context tokens at the one-hour cache-write rate`
    const cacheCard = hoverCard(detail === '' ? [rewake] : [rewake, detail], EDGE, columns)
    // The pace follows the cache on the first line when both fit, else it starts the next one.
    const paceX = cache === undefined || statusWidth([cache, paceText]) > columns ? EDGE : EDGE + cache.length + STATUS_GAP
    const paceCard = hoverCard([paceSource], paceX, columns)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        <Box alignItems="center" flexWrap="wrap" columnGap={STATUS_GAP} rowGap={0} paddingX={EDGE}>
          {cache === undefined ? (
            <Text dimColor> </Text>
          ) : (
            <Box key="cache" flexShrink={0}>
              <Text dimColor wrap="truncate-end">{cache}</Text>
              <Box position="absolute" top={cacheCard.top} left={cacheCard.left} width={cacheCard.width} display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round" paddingX={1}>
                <Text>{rewake}</Text>
                {detail === '' ? null : <Text dimColor>{detail}</Text>}
              </Box>
            </Box>
          )}
          <Box key="pace" flexShrink={0}>
            <Text dimColor wrap="truncate-end">{paceText}</Text>
            <Box position="absolute" top={paceCard.top} left={paceCard.left} width={paceCard.width} display="none" hover={{ display: 'flex' }} borderStyle="round" paddingX={1}>
              <Text>{paceSource}</Text>
            </Box>
          </Box>
          {agentsText === undefined ? null : (
            <Box flexShrink={0}>
              <Text dimColor wrap="truncate-end">{agentsText}</Text>
            </Box>
          )}
        </Box>
        <Box alignItems="center" gap={STATUS_GAP} paddingRight={EDGE}>
          <Box flexGrow={1} flexShrink={1} flexWrap="wrap" alignItems="center" columnGap={BUTTON_GAP} rowGap={1}>
            <Box flexShrink={0}>
              <Button key="suggest" label={label.suggest} onPress={() => suggestFeature($)} />
            </Box>
            <Box flexShrink={0}>
              <Button key="rebuild" label={label.rebuild} onPress={() => rebuildDraft($)} />
            </Box>
            <Box flexShrink={0}>
              <Button key="handoff" label={label.handoff} onPress={press => copyHandoff($, press)} />
            </Box>
            <Box flexShrink={0}>
              <Button key="codex" variant={codexOn ? 'primary' : 'secondary'} label={label.codex} onPress={() => toggleCodex($)} />
            </Box>
            {label.commit === undefined ? null : (
              <Box flexShrink={0}>
                <Button key="commit" label={label.commit} onPress={() => commitChanges($)} />
              </Box>
            )}
          </Box>
          {label.cost === undefined ? null : (
            <Box flexShrink={0}>
              <Text key="cost" dimColor wrap="truncate-end">{label.cost}</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // Terminal: the footer's mode labels sit just left of the model. The desktop draws no such footer,
  // so there the cost sits at the right end of the band's button row instead.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { usd } = await current($)
    if (usd === undefined) return next(e)

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, format(usd)] } })
  })
}
