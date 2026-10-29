import { expect, mock, test } from 'claude-code/testing'

import {
  cacheMinutesLeft,
  cleanSuggestion,
  codexInstructions,
  describe,
  buttonLabels,
  buttonsWidth,
  describeAgents,
  describeAgentsShort,
  describeCacheShort,
  hoverCard,
  pickFit,
  statusWidth,
  wrapRows,
  describeToolUse,
  handoffTranscript,
  format,
  inputUsdPerMTok,
  describePaceSource,
  pace,
  paceWindow,
  parseCommitMessage,
  rebuildPrompt,
  rewakeUsd,
  suggestionPrompt,
} from './register'

test('the rewake cost re-caches the context at twice the input price', () => {
  expect(inputUsdPerMTok('claude-opus-5-5')).toBe(4)
  expect(inputUsdPerMTok('claude-haiku-4-5')).toBe(1)
  expect(inputUsdPerMTok('some-other-model')).toBeUndefined()
  expect(format(rewakeUsd(100_000, 4))).toBe('$0.80')
})

test('commit messages keep a subject and body and drop any attribution', () => {
  const reply = '```\nAdd games pane with runner and tycoon\n\nAdds a pane with two games.\nCo-Authored-By: Claude <noreply@anthropic.com>\n🤖 Generated with Claude Code\n```'
  expect(parseCommitMessage(reply, 3)).toEqual({ subject: 'Add games pane with runner and tycoon', body: 'Adds a pane with two games.' })
  expect(parseCommitMessage('"Fix pace label"', 1)).toEqual({ subject: 'Fix pace label', body: '' })
  expect(parseCommitMessage('', 1)).toEqual({ subject: 'Update 1 file', body: '' })
  expect(parseCommitMessage('  \n', 4).subject).toBe('Update 4 files')
  expect(parseCommitMessage('x'.repeat(100), 1).subject.length).toBe(72)
})

const MIN = 60000
const HOUR = 60 * MIN

const fiveHour = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: new Date(5 * HOUR).toISOString() })

test('formats dollars to cents', () => {
  expect(format(348.5)).toBe('$348.50')
  expect(format(0)).toBe('$0.00')
})

test('the cache counts down an hour from the last response', () => {
  expect(cacheMinutesLeft(undefined, 0)).toBeUndefined()
  expect(cacheMinutesLeft(0, 0)).toBe(60)
  expect(cacheMinutesLeft(0, 8 * MIN + 1)).toBe(52)
  expect(cacheMinutesLeft(0, 61 * MIN)).toBe(0)
})

test('the 5-hour pace projects use so far to the reset', () => {
  // 30% in the first hour runs at 150% by the reset.
  expect(pace(fiveHour(30), 1 * HOUR)).toBe('Too Fast')
  expect(pace(fiveHour(45), 2.5 * HOUR)).toBe('Good Speed')
  expect(pace(fiveHour(20), 2.5 * HOUR)).toBe('Too Slow')
  expect(pace(fiveHour(5), 3 * MIN)).toBeUndefined()
  expect(pace(fiveHour(5), 10 * MIN)).toBe('Too Fast')
  expect(pace(fiveHour(100), 3 * HOUR)).toBe('Limit Hit')
  expect(pace({ kind: 'five_hour', percentUsed: 100 }, HOUR)).toBe('Limit Hit')
  expect(pace({ kind: 'five_hour', percentUsed: 30 }, HOUR)).toBeUndefined()
})

test('without a 5-hour reading the pace reads the weekly window', () => {
  const DAY = 24 * HOUR
  const weekly = { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(7 * DAY).toISOString() }
  const w = paceWindow([weekly])
  expect(w?.name).toBe('7-day')
  // 30% at the halfway mark runs at 60% by the reset.
  expect(pace(w!.limit, 3.5 * DAY, w!.windowMs)).toBe('Too Slow')
  expect(paceWindow([fiveHour(10), weekly])?.name).toBe('5-hour')
  expect(paceWindow([])).toBeUndefined()
  expect(describePaceSource([], 0)).toContain('No rate-limit reading')
  expect(describePaceSource([fiveHour(23)], 4 * HOUR)).toBe('5-hour window: 23% used, resets in 60m')
})

test('subagents read as running and finished', () => {
  expect(describeAgents({ running: [], finished: 0 })).toBeUndefined()
  expect(describeAgents({ running: ['a'], finished: 0 })).toBe('1 subagent running')
  expect(describeAgents({ running: [], finished: 3 })).toBe('3 subagents finished')
  expect(describeAgents({ running: ['a', 'b'], finished: 1 })).toBe('2 subagents running, 1 finished')
})

test('the bar lists the cache, the pace and subagents, with the cost on the right', () => {
  const stats = {
    usd: 3.81,
    contextPercent: 34,
    limits: [fiveHour(30), { kind: 'seven_day', percentUsed: 22 }],
    lastResponseAt: 52 * MIN,
  }
  expect(describe(stats, HOUR, { running: [], finished: 2 })).toEqual({
    left: 'Cache warm · 52m left  ·  Too Fast  ·  2 subagents finished',
    right: 'Session $3.81',
  })
  expect(describe(stats, 3 * HOUR).left.startsWith('Cache expired')).toBe(true)
  expect(describe({ limits: [] }, 0)).toEqual({ left: '', right: undefined })
})

test('the suggestion prompt carries the recent text and what was already suggested', () => {
  const prompt = suggestionPrompt({ prompts: ['make a cost mod'], replies: ['Done: the bar shows cost.'] }, ['Add a dark theme toggle'])
  expect(prompt).toContain('- make a cost mod')
  expect(prompt).toContain('Done: the bar shows cost.')
  expect(prompt).toContain('pick something different:\n- Add a dark theme toggle')
  expect(suggestionPrompt({ prompts: ['x'], replies: [] }, [])).not.toContain('Already suggested')
  expect(cleanSuggestion('  "Add a sound when a subagent finishes."\n')).toBe('Add a sound when a subagent finishes.')
})

test('the desktop band shows the session figures and follows the cost', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  let usd = 348.5
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 68000, percent: 34 }, rateLimits: [{ kind: 'seven_day', percentUsed: 22 }], cost: { usd } } }))

  for (const surface of ['desktop', 'mobile'] as const) {
    usd = 348.5
    const ui = await $.ui.mount({ plugin: 'session-cost', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10 } as never })
    expect(await ui.find({ type: 'Text', text: /Pace:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Session $348.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Context|Week/ })).toBeUndefined()
    expect(await ui.find({ key: 'suggest' })).toBeDefined()
    await ui.unmount()
  }
})

test('the suggest button asks for a message first when there is nothing to read', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let asked = 0
  on('model.complete', () => {
    asked += 1
    return { isAnswered: false, reason: 'empty-reply' } as never
  })

  const ui = await $.ui.mount({ plugin: 'session-cost', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })
  await ui.press({ key: 'suggest' })
  expect(asked).toBe(0)
  expect(toasts[0]).toContain('Send a message first')
  await ui.unmount()
})

const BAND = { plugin: 'session-cost', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never } as const

test('the rebuild prompt carries the recent text and the draft', () => {
  const prompt = rebuildPrompt({ prompts: ['make a cost mod'], replies: ['Done.'] }, '  add like a button thing that fixes my prompt  ')
  expect(prompt).toContain('- make a cost mod')
  expect(prompt.endsWith('The draft to rewrite:\nadd like a button thing that fixes my prompt')).toBe(true)
})

test('Rebuild Prompt replaces the draft with the rewritten prompt', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  let box = 'add like a button thing that fixes my prompt'
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', ($, e) => {
    box = e.text
    return { isFilled: true }
  })
  let sent = ''
  on('model.complete', ($, e) => {
    sent = e.prompt
    return { value: { isAnswered: true, text: '"Add a button that rewrites my draft prompt."', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'rebuild' })
  expect(sent).toContain('The draft to rewrite:\nadd like a button thing that fixes my prompt')
  expect(box).toBe('Add a button that rewrites my draft prompt.')
  await ui.unmount()
})

test('Rebuild Prompt asks for a draft when the box is empty', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'rebuild' })
  expect(toasts[0]).toContain('Type a rough prompt first')
  await ui.unmount()
})

test('the terminal footer gets the cost after the existing modes', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1.5 } } }))
  let drawn: readonly string[] = []
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    drawn = e.props.modes
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })

  const ui = await $.ui.mount({ plugin: 'session-cost', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  expect(drawn).toEqual(['focus', '$1.50'])
  await ui.unmount()
})

test('the handoff transcript keeps prompts, replies and tool calls, and drops engine notes', () => {
  const messages = [
    { role: 'user' as const, text: 'Add a handoff button<system-reminder>ignore me</system-reminder>', toolUses: [] },
    {
      role: 'assistant' as const,
      text: 'Adding it now.',
      toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'hooks/register.tsx' } }],
    },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [] },
    { role: 'assistant' as const, text: 'Done.', toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' }, isError: true as const }] },
  ]
  expect(handoffTranscript(messages)).toBe(
    'USER: Add a handoff button\nCLAUDE: Adding it now.\nCLAUDE RAN: Edit hooks/register.tsx\nCLAUDE: Done.\nCLAUDE RAN: Bash npm test (failed)',
  )
  expect(describeToolUse({ tool_use_id: 't3', tool: 'TodoWrite', input: {} })).toBe('TodoWrite')
})

test('a long handoff transcript keeps the first prompt and the newest lines', () => {
  const messages = [
    { role: 'user' as const, text: 'first ask', toolUses: [] },
    ...Array.from({ length: 50 }, (_, i) => ({ role: 'assistant' as const, text: `reply ${i}`, toolUses: [] })),
  ]
  const out = handoffTranscript(messages, 60).split('\n')
  expect(out[0]).toBe('USER: first ask')
  expect(out[1]).toMatch(/earlier lines left out/)
  expect(out.at(-1)).toBe('CLAUDE: reply 49')
})

test('the Codex instructions name the session folder and the resume line', () => {
  const text = codexInstructions('/work/app')
  expect(text).toContain('codex exec --cd "/work/app"')
  expect(text).toContain('Codex session: <id>')
})

const PROMPT = { text: 'fix the bug', wait: false, origin: { kind: 'composer' } } as const

test('the Codex toggle hands prompts to Codex only while it is on', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('ui.toast', () => ({ value: undefined }))
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.context)
    return { text: e.text }
  })

  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'codex' })).toBeDefined()
  await ui.press({ key: 'codex' })
  await $.prompt.submit(PROMPT)
  await ui.press({ key: 'codex' })
  await $.prompt.submit(PROMPT)
  await ui.unmount()

  expect(seen.length).toBe(3)
  expect(seen[0]).toBeUndefined()
  expect(seen[1]?.[0]).toContain('CODEX MODE is on')
  expect(seen[2]).toBeUndefined()
})

test('the band picks the longest labels that fit its width and wraps the rest', () => {
  const state = { busy: undefined, codexOn: false, changed: 7, committing: false, usd: 22.48 }
  const full = buttonLabels(false, state)
  const short = buttonLabels(true, state)
  expect(full.commit).toBe('⇪ Commit 7 files')
  expect(short).toEqual({ suggest: '✦ Suggest', rebuild: '✎ Rebuild', handoff: '⧉ Handoff', codex: '○ Codex', commit: '⇪ Commit 7', cost: '$22.48' })
  expect(pickFit(200, [full, short], buttonsWidth)).toBe(full)
  expect(pickFit(70, [full, short], buttonsWidth)).toBe(short)
  // Too narrow even for the short labels: still the short ones, and the row wraps them.
  expect(pickFit(30, [full, short], buttonsWidth)).toBe(short)

  expect(statusWidth(['Cache warm · 60m left', 'Pace: Too Fast', undefined])).toBe(21 + 2 + 14 + 2)
  expect(describeCacheShort({ limits: [], lastResponseAt: 0 }, 0)).toBe('Cache 60m')
  expect(describeAgentsShort({ running: ['a', 'b'], finished: 2 })).toBe('2 running, 2 done')
})

test('a hover card wraps to the band, sits above its part and stays inside the edges', () => {
  expect(wrapRows('Re-caches 439k context tokens at the one-hour cache-write rate', 80)).toBe(1)
  expect(wrapRows('Re-caches 439k context tokens at the one-hour cache-write rate', 30)).toBe(3)
  const lines = ['Rewake cost ≈ $3.51', 'Re-caches 439k context tokens at the one-hour cache-write rate']
  // Wide: as wide as its longest line, two rows above the part.
  expect(hoverCard(lines, 1, 200)).toEqual({ width: 66, top: -3, left: 0 })
  // Narrow: no wider than the band, taller for the wrapped line, and raised to match.
  const narrow = hoverCard(lines, 1, 40)
  expect(narrow.width).toBe(38)
  expect(narrow.top).toBe(-(1 + wrapRows(lines[1]!, 34) + 1))
  // A part far to the right slides its card left so it ends at the band's edge.
  expect(hoverCard(['5-hour window: 23% used, resets in 60m'], 30, 50).left).toBe(-(30 + 42 - 49))
})

for (const [columns, isShort] of [
  [44, true],
  [80, true],
  [140, false],
] as const) {
  test(`the desktop band at ${columns} columns draws ${isShort ? 'short' : 'full'} labels`, async ($, on) => {
    mock.clock(on)
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({
      value: { startedAt: 0, context: { window: 200000, tokens: 439000, percent: 34 }, rateLimits: [fiveHour(30)], cost: { usd: 22.48 } },
    }))

    for (const surface of ['desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'session-cost', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns } as never })
      expect(await ui.find({ type: 'Text', text: isShort ? '$22.48' : 'Session $22.48' })).toBeDefined()
      expect(await ui.find({ type: 'Button', label: isShort ? '✦ Suggest' : '✦ Suggest a feature' } as never)).toBeDefined()
      expect(await ui.find({ key: 'handoff' })).toBeDefined()
      await ui.unmount()
    }
  })
}
