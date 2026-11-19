import lunr from "lunr";

export type SearchMode = "wildcard" | "fuzzy" | "exact";
export type SparqlBinding = Record<string, { value: string }>;
export type FieldBinding = { entity: string; value: string };
export type LegacyBinding = { id: string; label?: string; altLabel?: string };

/** The entities of one type: their Lunr index, and their names to display. */
export type TypeGroup = {
  index: lunr.Index;
  /** URI → name to display, since Lunr only gives back the URI. */
  names: Map<string, string>;
};

/** The index of a project: one group per type of the config. */
export type TypedIndex = Map<string, TypeGroup>;

/** Key of the group of the entities that have none of the types of the config. */
export const UNTYPED_GROUP = "_untyped";
