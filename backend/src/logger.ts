import { config } from './config';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (config.isTest) return;
  if (levels[level] < (levels[config.logLevel as Level] ?? 20)) return;
  const line = { time: new Date().toISOString(), level, msg, ...meta };
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else console.log(out);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
