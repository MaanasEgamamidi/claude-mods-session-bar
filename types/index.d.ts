export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Stats = {
  usd?: number
  contextPercent?: number
  /** Input tokens the last response was answered over: what a restart re-caches. */
  contextTokens?: number
  limits: Limit[]
  /** When the last response landed, which is when the prompt cache was last refreshed. */
  lastResponseAt?: number
}

/** Subagents this session: the ones still running by id, and how many have finished. */
export type Agents = { running: string[]; finished: number }

/** The latest prompts and replies on the main thread, oldest first, for the suggest button. */
export type Recent = { prompts: string[]; replies: string[] }

/** The suggest, rebuild and handoff buttons: which one is waiting on the model, and the suggestions given so far. */
export type Suggest = { busy?: 'suggest' | 'rebuild' | 'handoff'; given: string[] }

/** The session folder's git state: how many files differ from the last commit, and whether a commit is being made. */
export type Git = { changed: number; isBusy: boolean }

/** The Codex toggle: while on, each prompt is handed to the Codex CLI instead of worked on directly. */
export type Codex = { isOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-cost': {
      git: Git
      stats: Stats
      tick: number
      agents: Agents
      recent: Recent
      suggest: Suggest
      codex: Codex
    }
  }
}
