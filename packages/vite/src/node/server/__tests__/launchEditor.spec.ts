import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import type { ViteDevServer } from '../index'
import { createServer } from '../index'
import { isWindows } from '../../../shared/utils'

type OnError = (fileName: string, errorMessage: string | null) => void
type LaunchEditor = (file: string, editor?: string, onError?: OnError) => void
type Middleware = (req: { url: string }, res: { end: () => void }) => void

const _require = createRequire(import.meta.url)

// vite bundles launch-editor-middleware and its launch-editor dependency.
// Resolve launch-editor the same way the middleware does, so that the copy
// patched through `pnpm.patchedDependencies` is the one under test.
const middlewarePath = _require.resolve('launch-editor-middleware')
const launchEditorPath = _require.resolve('launch-editor', {
  paths: [path.dirname(middlewarePath)],
})
const createMiddleware: () => Middleware = _require(middlewarePath)
const launchEditor: LaunchEditor = _require(launchEditorPath)

// launch-editor looks these functions up on the shared module objects when it
// is called, so stubbing them intercepts the editor process it would launch
const childProcess = _require('node:child_process')
const nodeFs = _require('node:fs')
const nodeOs = _require('node:os')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  })
}

// test files share the process (`isolate: false`), so always restore it
function restorePlatform() {
  Object.defineProperty(process, 'platform', originalPlatform)
}

const EXEC_OPTIONS = { stdio: 'inherit', shell: true }
const SPAWN_OPTIONS = { stdio: 'inherit' }
const CMD_METACHARS = ['&', '|', '<', '>', ',', ';', '=', '^']
const FILE_ROOT = isWindows ? 'C:\\project\\' : '/project/'

// file-system routing conventions of meta frameworks
const ROUTE_FILE_NAMES = [
  '+page.svelte',
  '$route.tsx',
  '(group)\\page.tsx',
  '@route\\page.tsx',
  '[slug]\\page.tsx',
]

// CMD.exe expands `%VAR%` before consuming `^` escapes and treats line
// breaks as command separators, so these cannot be escaped
const REJECTED_FILE_NAMES = [
  'C:\\project\\%PATH%.js',
  'C:\\project\\%VAR:old=new%.js',
  'C:\\project\\file.js\ncalc.exe',
  'C:\\project\\file.js\r\ncalc.exe',
  'C:\\project\\file.js\r&calc.exe',
]

// file names that editors would take for options running arbitrary commands
const OPTION_LIKE_FILES = [
  ['vim', '+call writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
  ['mvim', '-ccall writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
  ['gvim', '+call writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
  ['emacs', '--eval=(write-region "marker" nil "LAUNCH_EDITOR_MARKER")'],
  ['emacsclient', '-eatouch LAUNCH_EDITOR_MARKER'],
  ['notepad++', '-pluginMessage=LAUNCH_EDITOR_MARKER'],
]

function createFakeChildProcess() {
  return Object.assign(new EventEmitter(), { kill: vi.fn() })
}

/**
 * Whether `command` contains a metacharacter that is not escaped with `^`,
 * i.e. one that CMD.exe would interpret instead of passing it to the editor.
 */
function hasUnescapedCmdMetachar(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '^') {
      i++
    } else if (CMD_METACHARS.includes(command[i])) {
      return true
    }
  }
  return false
}

describe('launch-editor (CVE-2024-52011)', () => {
  let exec = vi.fn(createFakeChildProcess)
  let spawn = vi.fn(createFakeChildProcess)
  let onError = vi.fn()

  beforeEach(() => {
    exec = vi.fn(createFakeChildProcess)
    spawn = vi.fn(createFakeChildProcess)
    onError = vi.fn()
    setPlatform('win32')
    vi.spyOn(childProcess, 'exec').mockImplementation(exec)
    vi.spyOn(childProcess, 'spawn').mockImplementation(spawn)
    vi.spyOn(nodeFs, 'existsSync').mockReturnValue(true)
    // launch-editor logs the files it could not open
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    restorePlatform()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function expectLaunchCommand(command: string) {
    expect(spawn).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(command, EXEC_OPTIONS)
    expect(hasUnescapedCmdMetachar(command)).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  }

  describe('on Windows', () => {
    test('launches the editor through the shell', () => {
      launchEditor('C:\\project\\src\\main.ts', 'code', onError)
      expectLaunchCommand('code C:\\project\\src\\main.ts')
    })

    test('passes the line and column numbers', () => {
      launchEditor('C:\\project\\src\\main.ts:10:5', 'code', onError)
      expectLaunchCommand('code -r -g C:\\project\\src\\main.ts:10:5')
    })

    test('quotes file names containing spaces', () => {
      launchEditor('C:\\my project\\src\\main.ts', 'code', onError)
      expectLaunchCommand('code "C:\\my project\\src\\main.ts"')
    })

    test('quotes an editor path containing spaces', () => {
      const editor = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
      vi.stubEnv('LAUNCH_EDITOR', editor)
      launchEditor('C:\\project\\src\\main.ts', undefined, onError)
      expectLaunchCommand(`"${editor}" C:\\project\\src\\main.ts`)
    })

    // https://github.com/vitejs/launch-editor/security/advisories/GHSA-c27g-q93r-2cwf
    test('escapes the command injection from the advisory', () => {
      const file = 'C:\\Users\\myusername\\Downloads\\& curl 172.21.93.52'
      launchEditor(file, 'code', onError)
      expectLaunchCommand(
        'code ^"C:\\Users\\myusername\\Downloads\\^& curl 172.21.93.52^"',
      )
    })

    test.each(CMD_METACHARS)('escapes %s in file names', (char) => {
      launchEditor(`C:\\project\\a${char}calc.exe`, 'code', onError)
      expectLaunchCommand(`code ^"C:\\project\\a^${char}calc.exe^"`)
    })

    test('escapes all CMD metacharacters at once', () => {
      launchEditor('C:\\project\\&|<>,;=^file.js', 'code', onError)
      expectLaunchCommand('code ^"C:\\project\\^&^|^<^>^,^;^=^^file.js^"')
    })

    test('escapes CMD metacharacters next to the line number', () => {
      launchEditor('C:\\project\\&calc.exe.js:10:5', 'code', onError)
      expectLaunchCommand('code -r -g ^"C:\\project\\^&calc.exe.js:10:5^"')
    })

    test.each(ROUTE_FILE_NAMES)('opens route files like %s', (route) => {
      const file = `C:\\project\\src\\routes\\${route}`
      launchEditor(file, 'code', onError)
      expectLaunchCommand(`code ${file}`)
    })

    test.each(REJECTED_FILE_NAMES)('rejects %j', (file) => {
      launchEditor(file, 'code', onError)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(
        file,
        expect.stringContaining('"%" or line breaks'),
      )
    })

    test('escapes CMD metacharacters in /__open-in-editor requests', () => {
      vi.stubEnv('LAUNCH_EDITOR', 'code')
      const file = `${FILE_ROOT}a&calc.exe.js`
      const res = { end: vi.fn() }
      createMiddleware()({ url: `/?file=${encodeURIComponent(file)}` }, res)
      expect(res.end).toHaveBeenCalledTimes(1)
      // launch-editor passes the file to the editor by its absolute path
      const launchedFile = path.win32.resolve(FILE_ROOT, 'a^&calc.exe.js')
      expectLaunchCommand(`code ^"${launchedFile}^"`)
    })

    test('rejects "%" in /__open-in-editor requests', () => {
      vi.stubEnv('LAUNCH_EDITOR', 'code')
      const file = `${FILE_ROOT}%PATH%.js`
      const res = { end: vi.fn() }
      createMiddleware()({ url: `/?file=${encodeURIComponent(file)}` }, res)
      expect(res.end).toHaveBeenCalledTimes(1)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  describe('on other platforms', () => {
    beforeEach(() => {
      setPlatform('linux')
    })

    test('spawns the editor without a shell', () => {
      const file = '/project/a&calc.exe%PATH%.js'
      launchEditor(file, 'code', onError)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledWith('code', [file], SPAWN_OPTIONS)
      expect(onError).not.toHaveBeenCalled()
    })
  })
})

describe('launch-editor (CVE-2026-112944)', () => {
  let exec = vi.fn(createFakeChildProcess)
  let spawn = vi.fn((..._args: unknown[]) => createFakeChildProcess())
  let onError = vi.fn()

  beforeEach(() => {
    exec = vi.fn(createFakeChildProcess)
    spawn = vi.fn((..._args: unknown[]) => createFakeChildProcess())
    onError = vi.fn()
    vi.spyOn(childProcess, 'exec').mockImplementation(exec)
    vi.spyOn(childProcess, 'spawn').mockImplementation(spawn)
    vi.spyOn(nodeFs, 'existsSync').mockReturnValue(true)
    // launch-editor logs the files it could not open
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    restorePlatform()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  describe('on Windows', () => {
    beforeEach(() => {
      setPlatform('win32')
    })

    test('passes the editor an absolute path', () => {
      launchEditor('-pluginMessage=LAUNCH_EDITOR_MARKER', 'notepad++', onError)
      const file = path.win32.resolve('-pluginMessage=LAUNCH_EDITOR_MARKER')
      expect(spawn).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      expect(exec).toHaveBeenCalledWith(
        `notepad++ ^"${file.replace('=', '^=')}^"`,
        EXEC_OPTIONS,
      )
    })
  })

  // launch-editor resolves file names with the path semantics of the mocked
  // platform, which only match those of `path` on POSIX hosts
  describe.skipIf(isWindows)('on other platforms', () => {
    beforeEach(() => {
      setPlatform('linux')
    })

    test('resolves a relative file name to an absolute path', () => {
      launchEditor('src/main.ts', 'code', onError)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledWith(
        'code',
        [path.resolve('src/main.ts')],
        SPAWN_OPTIONS,
      )
    })

    test.each(OPTION_LIKE_FILES)('%s gets an absolute %j', (editor, file) => {
      launchEditor(file, editor, onError)
      launchEditor(`${file}:10:5`, editor, onError)
      expect(exec).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(2)
      for (const [command, args] of spawn.mock.calls as [string, string[]][]) {
        expect(command).toBe(editor)
        expect(args).not.toContain(file)
        expect(args[args.length - 1]).toBe(path.resolve(file))
        expect(path.isAbsolute(args[args.length - 1])).toBe(true)
      }
    })
  })

  // launch-editor converts paths for WSL with `path.relative` of the host
  describe.skipIf(isWindows)('on WSL', () => {
    // vim would run the command if it took this file name for an option
    const optionLikeFile = '+call system("touch LAUNCH_EDITOR_MARKER")'

    beforeEach(() => {
      setPlatform('linux')
      vi.spyOn(nodeOs, 'release').mockReturnValue('4.4.0-43-Microsoft')
      vi.spyOn(process, 'cwd').mockReturnValue('/mnt/c/project')
    })

    test('uses a relative path for files on a Windows drive', () => {
      vi.spyOn(process, 'cwd').mockReturnValue('/home/user/project')
      launchEditor('/mnt/c/project/file.js', 'vim', onError)
      expect(spawn).toHaveBeenCalledWith(
        'vim',
        ['./../../../mnt/c/project/file.js'],
        SPAWN_OPTIONS,
      )
    })

    test('resolves a relative file name before converting it', () => {
      launchEditor('file.js', 'vim', onError)
      expect(spawn).toHaveBeenCalledWith('vim', ['./file.js'], SPAWN_OPTIONS)
    })

    test('prefixes an option-like file name', () => {
      launchEditor(`/mnt/c/project/${optionLikeFile}`, 'vim', onError)
      expect(spawn).toHaveBeenCalledWith(
        'vim',
        [`./${optionLikeFile}`],
        SPAWN_OPTIONS,
      )
    })

    test('prefixes an option-like file name with a position', () => {
      launchEditor(`/mnt/c/project/${optionLikeFile}:10:5`, 'vim', onError)
      expect(spawn).toHaveBeenCalledWith(
        'vim',
        ['+call cursor(10, 5)', `./${optionLikeFile}`],
        SPAWN_OPTIONS,
      )
    })

    test('prefixes option-like files in /__open-in-editor requests', () => {
      vi.stubEnv('LAUNCH_EDITOR', 'vim')
      const file = `/mnt/c/project/${optionLikeFile}`
      const res = { end: vi.fn() }
      createMiddleware()({ url: `/?file=${encodeURIComponent(file)}` }, res)
      expect(res.end).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith(
        'vim',
        [`./${optionLikeFile}`],
        SPAWN_OPTIONS,
      )
    })
  })
})

// https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm
describe('launch-editor (CVE-2026-112942)', () => {
  let exec = vi.fn(createFakeChildProcess)
  let spawn = vi.fn(createFakeChildProcess)
  let onError = vi.fn()
  // an empty file name does not exist, like with `fs`; every other file does
  let existsSync = vi.fn((file: string) => file !== '')

  beforeEach(() => {
    exec = vi.fn(createFakeChildProcess)
    spawn = vi.fn(createFakeChildProcess)
    onError = vi.fn()
    existsSync = vi.fn((file: string) => file !== '')
    vi.spyOn(childProcess, 'exec').mockImplementation(exec)
    vi.spyOn(childProcess, 'spawn').mockImplementation(spawn)
    vi.spyOn(nodeFs, 'existsSync').mockImplementation(existsSync)
    // launch-editor logs the files it could not open
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    restorePlatform()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  describe('on Windows', () => {
    beforeEach(() => {
      setPlatform('win32')
    })

    // `fs.existsSync` normalizes `..` on Windows, so the directory before it
    // passed the check without existing once `:1:1` was stripped
    const files = [
      'C:\\project\\a&calc.exe\\..:1:1',
      'C:\\project\\%PATH%\\..:1:1',
    ]

    test.each(files)('checks the resolved file of %j', (file) => {
      launchEditor(file, 'code', onError)
      expect(existsSync).toHaveBeenCalledTimes(1)
      expect(existsSync).toHaveBeenCalledWith('C:\\project')
      expect(onError).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(exec).toHaveBeenCalledTimes(1)
      expect(exec).toHaveBeenCalledWith(
        'code -r -g C:\\project:1:1',
        EXEC_OPTIONS,
      )
    })

    test('does not resolve an empty file name', () => {
      launchEditor(':1:1', 'code', onError)
      expect(existsSync).toHaveBeenCalledWith('')
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  describe('on other platforms', () => {
    beforeEach(() => {
      setPlatform('linux')
    })

    test('checks the resolved file name', () => {
      launchEditor('/project/a&calc.exe/..:1:1', 'code', onError)
      expect(existsSync).toHaveBeenCalledTimes(1)
      expect(existsSync).toHaveBeenCalledWith('/project')
      expect(onError).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledWith(
        'code',
        ['-r', '-g', '/project:1:1'],
        SPAWN_OPTIONS,
      )
    })

    test('does not resolve an empty file name', () => {
      launchEditor(':1:1', 'code', onError)
      expect(existsSync).toHaveBeenCalledWith('')
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    })
  })
})

describe.runIf(isWindows)('/__open-in-editor on Windows', () => {
  let tmpDir: string
  let server: ViteDevServer | undefined
  let httpServer: http.Server | undefined
  let port: number

  const sendRequest = (requestPath: string) => {
    return new Promise<number | undefined>((resolve, reject) => {
      const url = `http://127.0.0.1:${port}${requestPath}`
      const req = http.get(url, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
    })
  }

  beforeAll(async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vite-launch-editor-')),
    )
    fs.writeFileSync(path.join(tmpDir, 'a&calc.exe.js'), '')
    server = await createServer({
      root: tmpDir,
      configFile: false,
      logLevel: 'silent',
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
      },
    })
    httpServer = http.createServer(server.middlewares)
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => resolve())
    })
    port = (httpServer.address() as AddressInfo).port
  })

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
    }
    await server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('escapes CMD metacharacters in the requested file name', async () => {
    vi.stubEnv('LAUNCH_EDITOR', 'code')
    const exec = vi.fn(createFakeChildProcess)
    vi.spyOn(childProcess, 'exec').mockImplementation(exec)

    const file = path.join(tmpDir, 'a&calc.exe.js')
    const query = `file=${encodeURIComponent(file)}`
    const statusCode = await sendRequest(`/__open-in-editor?${query}`)
    expect(statusCode).toBe(200)

    const command = `code ^"${path.join(tmpDir, 'a^&calc.exe.js')}^"`
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(command, EXEC_OPTIONS)
    expect(hasUnescapedCmdMetachar(command)).toBe(false)
  })
})
