/**
 * JSON Lines structured logger.
 *
 * Emits one JSON object per line to stdout:
 *   { ts, level, component, msg, correlation_id?, ...fields }
 *
 * This is an observability concern, not domain logic: unlike domain code
 * (which must go through the Clock abstraction, see Task 1.2), the logger
 * defaults to system time. Callers that need deterministic log timestamps
 * (e.g. tests) may inject `now`.
 */

import { ulid } from "./ulid.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  correlation_id?: string;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  correlation_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Returns an ISO-8601 timestamp string. Defaults to system time. */
  now?: () => string;
  /** Where to write each JSON line. Defaults to console.log. */
  write?: (line: string) => void;
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Creates a logger scoped to `component`. Each call emits a single JSON Line
 * to stdout (or the injected `write` sink).
 */
export function logger(component: string, options: LoggerOptions = {}): Logger {
  const now = options.now ?? defaultNow;
  const write = options.write ?? ((line: string) => console.log(line));

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    const { correlation_id, ...rest } = fields ?? {};
    const record: LogRecord = {
      ts: now(),
      level,
      component,
      msg,
      ...(correlation_id !== undefined ? { correlation_id } : {}),
      ...rest,
    };
    write(JSON.stringify(record));
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}

/** Generates a new correlation id (ULID) for tying together a request/tick/job. */
export function newCorrelationId(): string {
  return ulid();
}
