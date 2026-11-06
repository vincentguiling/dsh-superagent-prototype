import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTER_PRESET, Sessions, type SessionsHost } from '../src/app/sessions.ts'

type Execution = { name: string; arguments: Record<string, unknown> }
type Guard = (execution: Execution) => string | undefined
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** Exercise the installed Session guard without Runtime's CLI/account startup checks. */
async function fixture(preset = ROUTER_PRESET, worker = false) {
  const context = new Context(), agentContext = new Context()
  const restrict = vi.fn(() => () => {})
  let guard: Guard | undefined
  agentContext.reflect.provide('tools', {
    register: () => () => {}, get: (name: string) => ({ name }), restrict,
    guard: (check: Guard) => { guard = check; return () => {} },
  })
  agentContext.reflect.provide('skills', { register: () => () => {} })
  agentContext.reflect.provide('systemPrompt', { section: () => () => {} })
  const agent = { id: worker ? 'worker-ticket' : 'master', ctx: agentContext, status: 'idle',
    session: { header: { agentPreset: preset }, snapshotEvents: () => [] } } as unknown as Agent
  bindScopeParent(agent, {})
  context.reflect.provide('agents', new Map([[agent.id, agent]]))
  const version = { revision: 1, config: { skills: {} } }
  const host = { context, masterId: 'master', lifetime: new AbortController().signal,
    store: { tickets: { get: () => ({ id: 'ticket' }) } },
    prompts: { current: () => version, skills: () => [] },
    effects: { handle: () => {} }, health: { set: () => {} },
    tools: () => [], closing: () => false,
  } as unknown as SessionsHost
  const sessions = new Sessions(host)
  sessions.install()
  cleanups.push(() => sessions.dispose())
  await context.parallel('agent/created', { agent } as never)
  expect(guard).toBeTypeOf('function')
  return { check: (execution: Execution) => guard!(execution), restrict, context, agent }
}
const shell = (name: string, command: string, args: Record<string, unknown> = {}): Execution =>
  ({ name, arguments: { command, description: 'test', ...args } })

describe.each([ROUTER_PRESET, 'standard'])('main Session waiting under %s', preset => {
  it.each(['pwsh', 'bash'])('enforces %s timeout and default wait limits', async name => {
    const { check } = await fixture(preset)
    expect(check(shell(name, 'gh pr checks 7', { timeoutMs: 30_001 }))).toMatch(/^Reports/)
    expect(check(shell(name, 'gh pr checks 7', { timeoutMs: 30_001, run_in_background: true }))).toMatch(/^Reports/)
    expect(check(shell(name, 'gh pr checks 7', { timeoutMs: 30_000 }))).toBeUndefined()
    expect(check(shell(name, 'gh pr checks 7', { run_in_background: true }))).toBeUndefined()
    const result = check(shell(name, 'gh pr checks 7'))
    if (preset === ROUTER_PRESET) expect(result).toBeUndefined()
    else expect(result).toMatch(/^This shell waits up to 60 seconds by default/)
  })

  it('refuses PowerShell sleep commands regardless of timeout or background mode', async () => {
    const { check } = await fixture(preset)
    for (const command of ['Start-Sleep -Seconds 60', 'sleep 60', 'sTaRt-SlEeP -Milliseconds 1',
      'Write-Output done; Start-Sleep 5', 'Write-Output done\nsleep 5', 'Get-Item . | Start-Sleep 5',
      '& { Start-Sleep 60 }', 'if ($true) { sleep 5 }', '$(Start-Sleep 5)',
      'Microsoft.PowerShell.Utility\\Start-Sleep 5', '# comment\nStart-Sleep 5']) {
      for (const args of [{ timeoutMs: 1_000 }, { run_in_background: true }])
        expect(check(shell('pwsh', command, args)), command).toMatch(/^Reports/)
    }
  })

  it('allows sleep names as output, arguments, comments and here-string data', async () => {
    const { check } = await fixture(preset)
    for (const command of ['Write-Output "Start-Sleep"', "Write-Output 'sleep'", 'Get-Help Start-Sleep',
      'Write-Output "; Start-Sleep 5"', "Write-Output 'text; sleep 5'", 'Write-Output "escaped `"; Start-Sleep"',
      "Write-Output 'it''s; Start-Sleep 5'", 'Write-Output done # ; Start-Sleep 5',
      '<# Start-Sleep 5 #> Write-Output done', 'Write-Output @"\nStart-Sleep 5\n"@',
      "Write-Output @'\nsleep 5\n'@", 'Start-Sleeper 5', 'sleep.txt', 'Write-Output sleep'])
      expect(check(shell('pwsh', command, { timeoutMs: 1_000 })), command).toBeUndefined()
    expect(check(shell('pwsh', 'Write-Output "Start-Sleep"; sleep 5', { timeoutMs: 1_000 }))).toMatch(/^Reports/)
  })

  it('checks executable subexpressions inside expandable strings and here-strings', async () => {
    const { check } = await fixture(preset)
    for (const command of ['Write-Output "result=$(Start-Sleep 30)"', 'Write-Output @"\nresult=$(Start-Sleep 30)\n"@'])
      expect(check(shell('pwsh', command, { timeoutMs: 30_000 })), command).toMatch(/^Reports/)
    for (const command of ["Write-Output '$(Start-Sleep 30)'", 'Write-Output "result=`$(Start-Sleep 30)"'])
      expect(check(shell('pwsh', command, { timeoutMs: 30_000 })), command).toBeUndefined()
  })

  it('keeps the job wait cap and other tools unchanged', async () => {
    const { check } = await fixture(preset)
    expect(check({ name: 'job_output', arguments: { wait: true, timeout_ms: 5_001 } })).toMatch(/^Reports/)
    expect(check({ name: 'job_output', arguments: { wait: true, timeout_ms: 5_000 } })).toBeUndefined()
    expect(check({ name: 'read', arguments: {} })).toBeUndefined()
  })
})

it('keeps PowerShell available to workers without the main Session waiting limits', async () => {
  const { check, restrict } = await fixture('dsh-superagent-worker', true)
  expect(restrict).toHaveBeenCalledWith({ allow: expect.arrayContaining(['pwsh', 'bash']) })
  for (const command of ['Start-Sleep 60', 'sleep 60', 'Get-Item .'])
    expect(check(shell('pwsh', command, { timeoutMs: 120_000 }))).toBeUndefined()
  expect(check({ name: 'job_output', arguments: { wait: true, timeout_ms: 30_000 } })).toBeUndefined()
})
