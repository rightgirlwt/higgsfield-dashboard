import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a program (no shell) and returns what it printed; rejects with the tail of its error output if it fails or runs too long. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out'));
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `Exited with code ${code}`));
    });
  });
}
