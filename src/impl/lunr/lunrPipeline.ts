import lunr from "lunr";

// Strips diacritics, so that a word matches with or without its accents.
// Registered globally once; must be imported before any index build or load.
export const normalizeAccents = (token: lunr.Token): lunr.Token =>
  token.update((str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

lunr.Pipeline.registerFunction(normalizeAccents, "normalizeAccents");

/**
 * Removes what is not a letter or a digit at the start and the end of a word,
 * in any alphabet. It replaces `lunr.trimmer`, which only knows the ASCII
 * letters: it cut the accented letters at the edges of a word, and erased the
 * words of the other alphabets. Used on the words of the index and of a search.
 */
export const trimWord = (word: string): string =>
  word.replace(/^[^\p{L}\p{N}_]+/u, "").replace(/[^\p{L}\p{N}_]+$/u, "");

/** `trimWord` as a step of the Lunr pipeline; a word left empty is dropped. */
export const trimNonWord = (token: lunr.Token): lunr.Token | null => {
  const trimmed = token.update(trimWord);
  return trimmed.toString() === "" ? null : trimmed;
};

lunr.Pipeline.registerFunction(trimNonWord, "trimNonWord");
