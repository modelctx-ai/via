import type { AuthConfig, ConfigOrigin, CredentialRef } from './types';

/**
 * One source's statement about one server: either a full definition (framework configs) or a
 * partial override (via's own configs). Fields that are absent were not said.
 */
export interface ServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, CredentialRef>;
  cwd?: string;
  url?: string;
  headers?: Record<string, CredentialRef>;
  auth?: AuthConfig;
  alias?: string;
  domain?: string;
  rename?: Record<string, string>;
  disabled?: boolean;
  exclusive?: boolean;
  confirm?: 'destructive' | 'never';
  timeout?: number;
  concurrency?: number;
  budget?: number;
  noise?: string[];
  roots?: string[];
}

/** Server names are user data: build records without ever assigning `__proto__`. */
export function ownEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value).filter(([key]) => key !== '__proto__');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type OriginedDef = { def: ServerDef; origin: ConfigOrigin };
