// Flags that other command-line tools share (`--verbose`, `--limit`, `--format`…), from
// `data/common-flags.json` (data-files.md). An undeclared one that reaches a tool as an extra field
// is almost certainly not an argument the person meant to send (arguments.md, "JSON 输入").
import flagData from '../../../data/common-flags.json';
import { kebab } from '../../catalog/tokenize';

export interface CommonFlagsData {
  version: number;
  flags: string[];
}

export function compileCommonFlags(data: CommonFlagsData): (name: string) => boolean {
  const known = new Set(data.flags);
  return (name) => {
    const k = kebab(name);
    return known.has(k) || (k.startsWith('no-') && known.has(k.slice(3)));
  };
}

/** Whether `name` (as typed after `--`, any case or separator) is on the table. */
export const isCommonFlag: (name: string) => boolean = compileCommonFlags(flagData);
