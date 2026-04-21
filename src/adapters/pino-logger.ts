import { pino, type Logger as PinoLogger } from "pino";

import type { Redactor } from "../core/redactor";
import type { Logger } from "../shared/ports/logger";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export type CreateLoggerOptions = {
  readonly level?: LogLevel;
  readonly destination?: { write(msg: string): void };
  readonly redactor?: Redactor;
};

function resolveLevel(explicit: LogLevel | undefined): LogLevel {
  if (explicit) return explicit;
  const envLevel = process.env.GISTJET_LOG_LEVEL;
  if (envLevel && envLevel.length > 0) {
    return envLevel as LogLevel;
  }
  return "info";
}

function wrap(instance: PinoLogger): Logger {
  return {
    child(bindings) {
      return wrap(instance.child(bindings));
    },
    debug(event, payload) {
      instance.debug({ event, ...(payload ?? {}) });
    },
    info(event, payload) {
      instance.info({ event, ...(payload ?? {}) });
    },
    warn(event, payload) {
      instance.warn({ event, ...(payload ?? {}) });
    },
    error(event, payload) {
      instance.error({ event, ...payload });
    },
  };
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = resolveLevel(options.level);
  const destination = options.destination ?? process.stderr;
  const redactor = options.redactor;
  const instance = pino(
    {
      level,
      base: null,
      formatters: {
        level(label: string) {
          return { level: label };
        },
        ...(redactor
          ? {
              log(obj: Record<string, unknown>): Record<string, unknown> {
                return redactor.redactPayload(obj);
              },
            }
          : {}),
      },
    },
    destination,
  );
  return wrap(instance);
}
