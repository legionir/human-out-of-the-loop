/**
 * Spawn a process from an argv array — never a shell.
 *
 * Timeout kills the process group; output past the byte cap is truncated
 * and the child is killed.  Used by `run_command` / `run_tests` (J-01).
 */
import { spawn } from 'node:child_process';

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_COMMAND_MAX_BYTES = 32_768;

export interface SpawnArgvOptions {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
}

export interface SpawnArgvResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  error?: string;
  durationMs: number;
}

function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  const pid = child.pid;
  if (pid && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
      'error',
      () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      },
    );
    return;
  }
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* gone */
  }
}

export function spawnArgv(argv: readonly string[], options: SpawnArgvOptions): Promise<SpawnArgvResult> {
  const command = argv[0];
  const args = argv.slice(1);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_COMMAND_MAX_BYTES;
  const started = Date.now();

  if (!command) {
    return Promise.resolve({
      ok: false,
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      error: 'argv must not be empty',
      durationMs: 0,
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
      });
    } catch (err) {
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (extra: Partial<SpawnArgvResult> = {}): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        ok: extra.ok ?? false,
        code: extra.code ?? null,
        signal: extra.signal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        timedOut,
        durationMs: Date.now() - started,
        ...(extra.error ? { error: extra.error } : {}),
      });
    };

    const onAbort = (): void => {
      killTree(child);
      finish({ ok: false, error: 'Aborted' });
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted) {
      onAbort();
      return;
    }

    const collect = (chunk: Buffer, into: Buffer[], which: 'out' | 'err'): void => {
      const used = which === 'out' ? outBytes : errBytes;
      const room = maxBytes - used;
      if (room <= 0) return;
      if (chunk.byteLength > room) {
        into.push(chunk.subarray(0, room));
        if (which === 'out') outBytes = maxBytes;
        else errBytes = maxBytes;
        truncated = true;
        killTree(child);
        return;
      }
      into.push(chunk);
      if (which === 'out') outBytes += chunk.byteLength;
      else errBytes += chunk.byteLength;
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, stdout, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, stderr, 'err'));
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('exit', (code, signal) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        signal,
        ...(timedOut ? { error: `timed out after ${timeoutMs}ms` } : {}),
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();
  });
}
