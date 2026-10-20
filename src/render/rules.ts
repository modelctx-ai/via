import columnsData from '../../data/columns.json';
import noiseData from '../../data/noise.json';

/** Shape of `data/noise.json` (data-files.md). */
export interface NoiseData {
  version: number;
  fields: string[];
  keep: string[];
}

/** Shape of `data/columns.json`: how tables pick and show columns. */
export interface ColumnsData {
  version: number;
  maxColumns: number;
  /** Field names preferred when a table has more columns than fit, best first. */
  priority: string[];
  /** Fields that name an object when it appears inside a table cell. */
  labelKeys: string[];
}

export interface NoiseRules {
  isNoise(key: string): boolean;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Compile the noise field table. `extra` is the per-server `noise` config; `keep` wins over
 * `fields` and over `extra`.
 */
export function compileNoise(data: NoiseData, extra: readonly string[] = []): NoiseRules {
  const fields = [...data.fields, ...extra].map(globToRegExp);
  const keep = data.keep.map(globToRegExp);
  return {
    isNoise: (key) => !keep.some((re) => re.test(key)) && fields.some((re) => re.test(key)),
  };
}

export function defaultNoise(extra: readonly string[] = []): NoiseRules {
  return compileNoise(noiseData as NoiseData, extra);
}

export function defaultColumns(): ColumnsData {
  return columnsData as ColumnsData;
}
