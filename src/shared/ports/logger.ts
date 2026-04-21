export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(event: string, payload?: Record<string, unknown>): void;
  info(event: string, payload?: Record<string, unknown>): void;
  warn(event: string, payload?: Record<string, unknown>): void;
  error(event: string, payload: Record<string, unknown>): void;
}
