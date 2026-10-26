// Tools that no `destructiveHint` covers: words in the raw name that mean data is lost or access is
// taken away (data/destructive.json, arguments.md "危险操作").
import destructiveData from '../../data/destructive.json';
import { tokenize } from './tokenize';

let cached: ReadonlySet<string> | undefined;

export function defaultDestructiveWords(): ReadonlySet<string> {
  cached ??= new Set(destructiveData.words);
  return cached;
}

/**
 * True when a word of the raw tool name is in `words`. The raw name is tokenized, not the canonical
 * form, so the answer does not change with the split rules or with `rename`. Whole words only:
 * `list_deleted_items` and `dropbox_search` do not match.
 */
export function inferDestructive(rawName: string, words: ReadonlySet<string>): boolean {
  return tokenize(rawName).some((w) => words.has(w));
}
