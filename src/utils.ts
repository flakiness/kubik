import { sha256 as sha256Text } from "js-sha256";

const ID_SEPARATOR = sha256Text(sha256Text('kubik'));

export function sha256(data: string | string[]): string {
  if (Array.isArray(data))
    return sha256Text(data.join(ID_SEPARATOR));
  return sha256Text(data);
}

/**
 * Brands a type by intersecting it with a type with a brand property based on
 * the provided brand string.
 */
export type Brand<T, Brand extends string> = T & {
  readonly [B in Brand as `__${B}_brand`]: never;
};