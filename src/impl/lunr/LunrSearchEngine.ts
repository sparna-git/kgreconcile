import lunr from "lunr";
import { ReconcileResult } from "../../interfaces/ReconcileServiceIfc";
import { TypedIndex, TypeGroup, SearchMode, UNTYPED_GROUP } from "./types";
import { trimWord } from "./lunrPipeline";
import logger from "../../utils/logger";

/**
 * A candidate found by Lunr, with the name to display, its types, and the
 * share of the searched words it contains (in any of its labels), from 0 to 1.
 */
type Hit = {
  ref: string;
  score: number;
  name: string;
  types: string[];
  coverage: number;
};

/** A group of the index, with its key: the type, or `UNTYPED_GROUP`. */
type KeyedGroup = [string, TypeGroup];

export class LunrSearchEngine {
  // Top result must be this much better (relatively) than the 2nd to be a definitive match
  private static MATCH_MIN_GAP = 0.3;
  // In the wildcard search, a word identical to the query weighs this much more than its extensions
  private static EXACT_WORD_BOOST = 10;
  // In the wildcard search, a word found with a typo weighs this much less than its extensions
  private static TYPO_BOOST = 0.5;
  // In the wildcard search, the words that can also be found with a typo
  private static TYPO_MIN_LENGTH = 5;

  constructor(
    private readonly groups: TypedIndex,
    private readonly fieldBoosts: Map<string, number>,
    private readonly maxResults: number,
  ) {}

  /**
   * Searches the name in the group of the given type, or in every group when
   * no type is given.
   */
  search(name: string, type?: string): ReconcileResult[] {
    const sanitized = this.sanitize(name);

    let groups: KeyedGroup[];
    if (type) {
      const group = this.groups.get(type);
      groups = group ? [[type, group]] : [];
    } else {
      groups = [...this.groups.entries()];
    }

    const { hits, mode } = this.runCascade(sanitized, groups);

    logger.info(
      {},
      `[lunr-recon] Lunr → ${hits.length} result(s) for "${name}" (${mode})${type ? ` [type: ${type}]` : ""}`,
    );

    if (hits.length === 0) return [];

    // The results that carry exactly the searched name come first. They are
    // worth 100, the others 99 at most; without an exact name, the best is 100.
    const exact = new Set(
      hits.filter((h) => this.hasLabel(h, sanitized)).map((h) => h.ref),
    );
    const ordered = [
      ...hits.filter((h) => exact.has(h.ref)),
      ...hits.filter((h) => !exact.has(h.ref)),
    ];
    const maxScore = hits[0].score;
    const scoreOf = (h: Hit) => {
      const relative = Math.round((h.score / maxScore) * 100);
      if (exact.size === 0) return relative;
      return exact.has(h.ref) ? 100 : Math.min(99, relative);
    };
    const isMatch = this.isConfidentMatch(ordered, mode, exact.size);

    return ordered.slice(0, this.maxResults).map((h, i) => ({
      id: h.ref,
      name: h.name,
      ...(h.types.length > 0 && { type: h.types }),
      score: scoreOf(h),
      match: i === 0 && isMatch,
    }));
  }

  private sanitize(term: string): string {
    return term
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[+\-~^:]/g, " ")
      .toLowerCase()
      // strip the punctuation around each word, as the index does
      .split(/\s+/)
      .map(trimWord)
      .filter(Boolean)
      .join(" ");
  }

  /**
   * Tries the searches from the strictest to the loosest, and stops at the
   * first one that finds something in the given groups.
   */
  private runCascade(
    sanitized: string,
    groups: KeyedGroup[],
  ): { hits: Hit[]; mode: SearchMode } {
    const tokens = sanitized.split(/\s+/).filter(Boolean);
    const fields = [...this.fieldBoosts.entries()];

    // 1. Wildcard suffix — best for partial/autocomplete input. The exact word is
    //    added with a higher boost: otherwise a rare extension of a frequent
    //    word outscores the word itself.
    //    A long word may also carry a typo, with a lower boost: otherwise the
    //    other words already find results here, and the fuzzy steps below never
    //    run. The typo does not count in the share of the words found, so it
    //    never makes a sure match.
    let hits = this.queryGroups(groups, tokens, () => 0, (q) => {
      for (const token of tokens)
        for (const [field, boost] of fields) {
          q.term(token, {
            fields: [field],
            boost: boost * LunrSearchEngine.EXACT_WORD_BOOST,
          });
          q.term(token, {
            fields: [field],
            boost,
            wildcard: lunr.Query.wildcard.TRAILING,
          });
          if (token.length >= LunrSearchEngine.TYPO_MIN_LENGTH)
            q.term(token, {
              fields: [field],
              boost: boost * LunrSearchEngine.TYPO_BOOST,
              editDistance: 1,
            });
        }
    });
    if (hits.length > 0) return { hits, mode: "wildcard" };

    // 2. Fuzzy ~1 per token — handles single-char typos
    hits = this.queryGroups(groups, tokens, () => 1, (q) => {
      for (const token of tokens)
        for (const [field, boost] of fields)
          q.term(token, { fields: [field], boost, editDistance: 1 });
    });
    if (hits.length > 0) return { hits, mode: "fuzzy" };

    // 3. Fuzzy ~2 for tokens ≥5 chars — handles combined typo+incomplete input
    if (tokens.some((t) => t.length >= 5)) {
      const editDistance = (token: string) => (token.length >= 5 ? 2 : 1);
      hits = this.queryGroups(groups, tokens, editDistance, (q) => {
        for (const token of tokens)
          for (const [field, boost] of fields)
            q.term(token, {
              fields: [field],
              boost,
              editDistance: editDistance(token),
            });
      });
      if (hits.length > 0) return { hits, mode: "fuzzy" };
    }

    // 4. Exact — final fallback
    hits = this.queryGroups(groups, tokens, () => 0, (q) => {
      for (const token of tokens)
        for (const [field, boost] of fields)
          q.term(token, { fields: [field], boost });
    });
    return { hits, mode: "exact" };
  }

  /**
   * Runs the same query in each group, and merges the results by score.
   *
   * Each group scores in its own Lunr index, so the scores of two groups do
   * not compare. When several groups are searched (no type is given), the
   * score of a result is therefore the share of the searched words it
   * contains, which means the same in every group, times its score in its
   * group divided by the best one of the group. A weak match does not climb
   * to the top just because it is the best of a small group. With a single
   * group (a type is given), the order is the one of Lunr.
   *
   * An entity found in two groups keeps its best score, and the types of both.
   */
  private queryGroups(
    groups: KeyedGroup[],
    tokens: string[],
    editDistance: (token: string) => number,
    build: (q: lunr.Query) => void,
  ): Hit[] {
    const merging = groups.length > 1;
    const best = new Map<string, Hit>();
    for (const [key, { index, names }] of groups) {
      let results: lunr.Index.Result[];
      try {
        results = index.query(build);
      } catch {
        continue;
      }
      if (results.length === 0) continue;
      const groupMax = results.reduce((max, r) => Math.max(max, r.score), 0) || 1;
      const groupTypes = key === UNTYPED_GROUP ? [] : [key];
      for (const r of results) {
        const coverage = wordCoverage(r, tokens, editDistance);
        const score = (r.score / groupMax) * (merging ? coverage : 1);
        const previous = best.get(r.ref);
        if (!previous) {
          best.set(r.ref, {
            ref: r.ref,
            score,
            name: names.get(r.ref) ?? r.ref,
            types: [...groupTypes],
            coverage,
          });
          continue;
        }
        if (score > previous.score) previous.score = score;
        if (coverage > previous.coverage) previous.coverage = coverage;
        for (const t of groupTypes)
          if (!previous.types.includes(t)) previous.types.push(t);
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Whether the first result is sure enough to be used without asking.
   * `hits` are in the order of the answer (exact names first), `exactCount` is
   * the number of results that carry exactly the searched name.
   */
  private isConfidentMatch(
    hits: Hit[],
    mode: SearchMode,
    exactCount: number,
  ): boolean {
    // Fuzzy results are inherently uncertain — never auto-accept
    if (mode === "fuzzy") return false;
    // Several results carry exactly the searched name: homonyms, a choice to make
    if (exactCount > 1) return false;
    // The first result must contain every searched word, in its name or another label
    if (hits[0].coverage < 1) return false;
    // Single result, or the only one that carries exactly the searched name
    if (hits.length === 1 || exactCount === 1) return true;
    // Top result must be at least MATCH_MIN_GAP relatively better than the second
    const gap = (hits[0].score - hits[1].score) / hits[0].score;
    return gap >= LunrSearchEngine.MATCH_MIN_GAP;
  }

  private hasLabel(hit: Hit, sanitized: string): boolean {
    return this.sanitize(hit.name) === sanitized;
  }
}

/**
 * Share of the searched words found in a result, from 0 to 1: a word is found
 * when one of the words Lunr matched in the result starts with it, or, in a
 * fuzzy search, is within its edit distance.
 */
function wordCoverage(
  result: lunr.Index.Result,
  tokens: string[],
  editDistance: (token: string) => number,
): number {
  const words = [...new Set(tokens)];
  if (words.length === 0) return 1;
  const matched = Object.keys(result.matchData.metadata);
  const found = words.filter((word) => {
    const distance = editDistance(word);
    return matched.some(
      (term) =>
        term.startsWith(word) ||
        (distance > 0 && levenshtein(term, word) <= distance),
    );
  });
  return found.length / words.length;
}

/** Number of single-letter edits to turn one word into the other. */
function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
