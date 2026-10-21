// Generic words left out of tool descriptions when a tool is indexed for `via find`
// (data/stopwords.json, discovery.md "搜索"). Verbs of the verb table are not listed here: the
// index drops repeated verbs by weight, not by a list.
import stopwordsData from '../../data/stopwords.json';

let cached: ReadonlySet<string> | undefined;

export function defaultStopwords(): ReadonlySet<string> {
  cached ??= new Set(stopwordsData.words);
  return cached;
}
