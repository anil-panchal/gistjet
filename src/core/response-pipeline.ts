import type { Redactor } from "./redactor";

export function redactResponse<T>(redactor: Redactor, value: T): T {
  return redactor.redactPayload(value);
}

export function wrapHandler<Args extends readonly unknown[], T>(
  redactor: Redactor,
  handler: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    const result = await handler(...args);
    return redactor.redactPayload(result);
  };
}
