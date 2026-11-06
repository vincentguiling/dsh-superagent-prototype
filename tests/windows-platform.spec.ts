import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, workerProbe } from '../src/deployment.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { absolutePathPattern, isAbsolutePath, nativeExecutable } from '../src/infra/platform.ts'
import { testDeployment } from './fixtures/deployment.ts'

const temporary: string[] = []
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'superagent platform ')); temporary.push(dir); return dir }
afterEach(() => { vi.unstubAllEnvs(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('accepts Windows drive roots and UNC shares, and rejects relative or current-drive paths', () => {
  for (const path of ['C:\\state', 'c:/state', '\\\\server\\share', '\\\\server\\share\\state', '//server/share/state']) {
    expect(isAbsolutePath(path, 'win32'), path).toBe(true)
    expect(absolutePathPattern('win32').test(path), path).toBe(true)
  }
  for (const path of ['C:state', 'C:', 'state', '\\state', '/state', '\\\\server', '//server/', '\\\\?\\C:\\state', '\\\\.\\pipe\\x']) {
    expect(isAbsolutePath(path, 'win32'), path).toBe(false)
  }
})
it('preserves POSIX absolute paths and executable scripts', () => {
  expect(isAbsolutePath('/srv/state', 'linux')).toBe(true)
  for (const path of ['C:/state', 'state', '~/state']) expect(isAbsolutePath(path, 'linux')).toBe(false)
  expect(() => nativeExecutable('/srv/lark-cli.cmd', 'linux')).not.toThrow()
})
it('rejects Windows batch and script launchers rather than invoking a shell', () => {
  for (const path of ['lark.cmd', 'lark.BAT', 'lark.ps1', 'C:\\bin\\lark.cmd']) {
    expect(() => nativeExecutable(path, 'win32')).toThrow('native .exe')
  }
  expect(() => nativeExecutable('C:\\Program Files\\gh.EXE', 'win32')).not.toThrow()
})
it('passes metacharacters, spaces, quotes, percent signs and newlines literally through Commands.run', async () => {
  const args = ['two words', 'a"b', 'back\\slash\\', '& echo injected', '|', '<', '>', '^', '%PATH%', '!name!', '`whoami`', '$(whoami)', 'line1\nline2', '']
  const output = await new Commands(() => testDeployment(), {}, new AbortController().signal)
    .run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args])
  expect(JSON.parse(output)).toEqual(args)
})

describe.skipIf(process.platform !== 'win32')('native Windows platform', () => {
  it('uses the same fully absolute path rules for deployment and executor settings', () => {
    for (const path of ['C:\\state', '\\\\server\\share\\state']) {
      expect(Config({ stateDir: path }).stateDir).toBe(path)
      expect(ExecutorConfigSchema.parse({ directory: path }).directory).toBe(path)
    }
    for (const path of ['C:state', '\\state', '/state', '\\\\server']) {
      expect(() => Config({ stateDir: path })).toThrow()
      expect(() => ExecutorConfigSchema.parse({ directory: path })).toThrow()
    }
    expect(ExecutorConfigSchema.parse({ directory: '' }).directory).toBe('')
  })
  it('finds .EXE through PATHEXT, ignores relative PATH entries and excludes worker shims', () => {
    const dir = directory(), bin = join(dir, 'bin'), shims = join(dir, 'worker-bin')
    mkdirSync(bin); mkdirSync(shims)
    copyFileSync(process.execPath, join(bin, 'agent.exe')); copyFileSync(process.execPath, join(shims, 'agent.exe'))
    writeFileSync(join(bin, 'agent.cmd'), '@echo not supported')
    vi.stubEnv('PATHEXT', '.CMD;.eXe;.BAT')
    expect(executable('agent', ['relative', shims, bin].join(delimiter), shims)).toBe(join(bin, 'agent.eXe'))
    expect(executable(join(bin, 'agent.exe'), '')).toBe(join(bin, 'agent.exe'))
    expect(executable(join(bin, 'agent'), '')).toBe(join(bin, 'agent.eXe'))
    for (const name of ['C:agent', 'bin\\agent', '.\\agent', '/agent', '\\agent']) {
      expect(() => executable(name, bin)).toThrow('command name or an absolute path')
    }
    expect(() => executable('agent.cmd', bin)).toThrow('native .exe')
    vi.stubEnv('PATHEXT', '.CMD;.BAT')
    expect(() => executable('agent', bin)).toThrow('not an executable file on PATH')
  })
  it('resolves configured GitHub and Feishu accounts through native executables', async () => {
    const dir = directory(), cli = join(dir, 'account.exe')
    copyFileSync(process.execPath, cli)
    const machine = machineOf(Config({ stateDir: dir }))
    const github = vi.fn().mockResolvedValueOnce('{"login":"agent-bot","id":7}')
      .mockResolvedValueOnce('{"name":"acme/widgets","push":true}')
    expect(await resolveDeployment(machine, { repository: 'acme/widgets', cli }, github, ''))
      .toMatchObject({ github: { cli, login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' } })
    expect(github).toHaveBeenNthCalledWith(1, [cli, 'api', 'user'])
    const feishu = vi.fn().mockResolvedValueOnce('{"appId":"cli_bot","identities":{"bot":{"status":"ready"}}}')
      .mockResolvedValueOnce('strict-mode: bot (source: profile)')
      .mockResolvedValueOnce('{"bot":{"open_id":"ou_bot","app_name":"Bot"}}')
    expect(await resolveFeishuBot(machine, { cli }, feishu, '')).toMatchObject({ cli, appId: 'cli_bot', botId: 'ou_bot' })
    expect(feishu).toHaveBeenNthCalledWith(1, [cli, 'auth', 'status'])
  })
  it('rejects batch launchers in the runtime Commands path as well as startup discovery', async () => {
    await expect(new Commands(() => testDeployment(), {}, new AbortController().signal).run('agent.cmd', ['& echo injected']))
      .rejects.toThrow('native .exe')
  })
  it('overrides only PATH and notifier settings so the subprocess runtime can scrub host secrets', async () => {
    const dir = directory(), shims = join(dir, 'worker-bin'), bin = join(dir, 'bin')
    vi.stubEnv('PATH', [shims, bin].join(delimiter))
    vi.stubEnv('GH_TOKEN', 'must-not-be-explicitly-forwarded')
    vi.stubEnv('SUPERAGENT_SECRET', 'must-not-be-explicitly-forwarded')
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve({ exitCode: 0 }), collected: {} })
    const subprocess = { spawn } as unknown as SubprocessRuntime
    const argv = [process.execPath, '--version']
    await workerProbe(subprocess, dir, dir, new AbortController().signal)(argv)
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv, cwd: dir, env: {
      PATH: bin, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    } }))
    expect(Object.keys(spawn.mock.calls[0]![0].env).sort()).toEqual(['LARKSUITE_CLI_NO_SKILLS_NOTIFIER', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER', 'PATH'])
  })
})
