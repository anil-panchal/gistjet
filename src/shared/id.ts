import { ulid } from "ulid";

export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const MAPPING_ID_PATTERN = new RegExp(`^[${CROCKFORD_BASE32_ALPHABET}]{26}$`);

export function createMappingId(): string {
  return ulid();
}

export function isMappingId(value: unknown): value is string {
  return typeof value === "string" && MAPPING_ID_PATTERN.test(value);
}
