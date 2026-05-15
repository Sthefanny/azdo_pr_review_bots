import { redactSecrets } from "./hash.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolvedLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase().trim();
  if (raw === "debug") return "debug";
  if (raw === "warn") return "warn";
  if (raw === "error") return "error";
  return "info";
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const min = ORDER[resolvedLevel()];
  const format = (
    lvl: LogLevel,
    msg: unknown,
    extras: unknown[]
  ): void => {
    if (ORDER[lvl] < min) return;
    const serialized = serialize(msg, extras);
    const line =
      lvl === "error"
        ? `[${scope}] ${serialized}`
        : `[${lvl}] [${scope}] ${serialized}`;
    if (lvl === "error") {
       
      console.error(redactSecrets(line));
    } else if (lvl === "warn") {
       
      console.warn(redactSecrets(line));
    } else {
       
      console.log(redactSecrets(line));
    }
  };

  return {
    debug: (first, ...rest) => format("debug", first, rest),
    info: (first, ...rest) => format("info", first, rest),
    warn: (first, ...rest) => format("warn", first, rest),
    error: (first, ...rest) => format("error", first, rest),
  };
}

function serialize(msg: unknown, extras: unknown[]): string {
  const parts = [pretty(msg), ...extras.map(pretty)];
  return parts.filter((p) => p.length > 0).join(" ");
}

function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
