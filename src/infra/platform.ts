/** Platform rules shared by configuration and shell-free CLI execution. */
import { win32 } from 'node:path'

/** Windows paths must name a drive root or UNC server/share; current-drive and drive-relative paths are ambiguous. */
export function absolutePathPattern(platform = process.platform): RegExp {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+(?:[\\/]|$))/ : /^\//
}
export const isAbsolutePath = (path: string, platform = process.platform): boolean => absolutePathPattern(platform).test(path)

/** Batch files require cmd.exe parsing. Keep CLI argv literal by supporting native .exe files only on Windows. */
export function nativeExecutable(program: string, platform = process.platform): void {
  if (platform !== 'win32') return
  const extension = win32.extname(program)
  if (extension && extension.toLowerCase() !== '.exe') throw new Error('Windows CLI commands must be native .exe files; batch and script launchers are not supported')
}
