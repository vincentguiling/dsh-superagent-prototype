import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)
let dir: string
const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
// Exercise a real PowerShell script call, including its handling of empty arguments.
const run = (name: string, args: string[] = [], path = process.env.PATH ?? '', bare = false) => {
  const command = '& ' + quote(bare ? name : join(workerBin(dir), name + '.ps1')) + ' ' + args.map(quote).join(' ') + '; exit $LASTEXITCODE'
  const result = exec(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { timeout: 10_000, cwd: dir, env: { ...process.env, PATH: path } })
  result.child.stdin?.end('target stdin')
  return result
}

describe.skipIf(process.platform !== 'win32')('Windows worker shims', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "environment 中文 space & ' ")); mkdirSync(join(dir, 'real')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('removes every spelling of its PATH directory before invoking the configured executable', async () => {
    const report = join(dir, 'report.cjs')
    writeFileSync(report, 'console.log(JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH }))')
    const target = join(dir, 'real', 'account tool.exe')
    copyFileSync(process.execPath, target)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: target } }), [])
    const bin = workerBin(dir)
    const rest = join(dir, 'venv')
    const result = await run('gh', [report, 'api', 'user'], [bin, bin.toUpperCase() + '\\.', '"' + bin + '"', rest].join(delimiter), true)
    expect(JSON.parse(result.stdout)).toEqual({ args: ['api', 'user'], path: rest })
  })

  it('preserves native executable arguments, inherited stdio and nonzero exit status', async () => {
    const report = join(dir, 'report.cjs')
    writeFileSync(report, 'console.log(JSON.stringify({ args: process.argv.slice(2), input: require("node:fs").readFileSync(0, "utf8") })); console.error("target stderr"); process.exitCode = 37')
    const target = join(dir, 'real', 'account %COMSPEC% tool.exe')
    copyFileSync(process.execPath, target)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: target }, feishu: { ...testDeployment().feishu!, cli: target } }), ['gh', 'git', 'lark-cli'])
    const args = ['', 'two words', '{"key":"value with spaces"}', 'a&b', 'a|b', 'a<b', 'a>b', '(value)', 'a^b', '!value!', 'tail\\', 'tail\\\\', 'say "hello"', 'slash\\"quote', '100%', '%COMSPEC%', '%PATH%', '%UNDEFINED_SHIM_VALUE%', 'line\nnext\r\nlast', 'single\'quote', '"&echo INJECTED>injected.txt&"', '']
    for (const name of ['gh', 'lark-cli']) {
      const result = await run(name, [report, ...args], '').catch(error => error)
      expect(result.code).toBe(37)
      expect(JSON.parse(result.stdout)).toEqual({ args, input: 'target stdin' })
      expect(result.stderr.trim()).toBe('target stderr')
    }
    expect(readdirSync(dir)).not.toContain('injected.txt')
  })

  it('blocks commands and an absent Feishu bot without interpreting account text as source', async () => {
    const login = 'agent & echo INJECTED>injected.txt & rem'
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, login }, feishu: undefined }), ['personal-gh', 'gh', 'git', 'lark-cli'])
    const blocked = await run('personal-gh').catch(error => error)
    expect(blocked.code).toBe(1)
    expect(blocked.stdout).toBe('')
    expect(blocked.stderr.trim()).toBe('personal-gh is blocked in this installation; use gh, which acts as ' + login + '.')
    expect(readdirSync(dir)).not.toContain('injected.txt')
    const absent = await run('lark-cli').catch(error => error)
    expect(absent.code).toBe(1)
    expect(absent.stderr.trim()).toBe('lark-cli is unavailable: this installation has no Feishu bot.')
    expect(readdirSync(workerBin(dir))).not.toContain('git.ps1')
  })

  it('updates CRLF and legacy markers, removes obsolete shims, and refuses foreign files', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    for (const file of [...readdirSync(workerBin(dir)).map(name => join(workerBin(dir), name)), workerGitConfig(dir)]) {
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n').replaceAll('Written by dsh-superagent', 'Written by dsh-go'))
    }
    writeFileSync(join(workerBin(dir), 'gh.cmd'), '@rem  Written by dsh-go on every start; edits are lost.\r\n@echo off\r\n')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh.cjs', 'gh.ps1', 'lark-cli.cjs', 'lark-cli.ps1'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
    writeFileSync(join(workerBin(dir), 'notes'), 'foreign\r\ntext\r\n# Written by dsh-superagent on every start; edits are lost.\r\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('notes was not written by dsh-superagent')
    expect(readFileSync(join(workerBin(dir), 'notes'), 'utf8')).toMatch(/^foreign/)
  })
})
