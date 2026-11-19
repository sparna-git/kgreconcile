import fs from "fs";
import path from "path";
import lunr from "lunr";
import { TypedIndex } from "./types";
import logger from "../../utils/logger";

/**
 * Version of the way the words are stored, written in the file. A file of
 * another version is rebuilt: 2 = punctuation trimmed in any alphabet, after
 * the accents are removed.
 */
const INDEX_VERSION = 2;

/**
 * Saves the index of a project to a JSON file and loads it back, one entry per
 * type group:
 *
 *   { "version": 2, "groups": { "<type>": { "index": <Lunr index>, "names": { "<uri>": "<name>" } } } }
 */
export class LunrIndexStore {
  constructor(private readonly filePath: string) {}

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** The saved index, or null when the file cannot be read or has an older format. */
  async load(): Promise<TypedIndex | null> {
    try {
      logger.info({}, `[lunr-recon] Loading index from "${this.filePath}"…`);
      const raw = JSON.parse(
        await fs.promises.readFile(this.filePath, "utf-8"),
      );

      if (!raw.groups || raw.version !== INDEX_VERSION) {
        logger.warn(
          {},
          `[lunr-recon] Index file of an older format (version ${raw.version ?? 1}, expected ${INDEX_VERSION}) — rebuilding from SPARQL.`,
        );
        return null;
      }

      const groups: TypedIndex = new Map();
      let entities = 0;
      for (const [key, group] of Object.entries(
        raw.groups as Record<
          string,
          { index: object; names: Record<string, string> }
        >,
      )) {
        const names = new Map(Object.entries(group.names));
        groups.set(key, { index: lunr.Index.load(group.index), names });
        entities += names.size;
      }

      logger.info(
        {},
        `[lunr-recon] Index loaded: ${entities} entity(ies) in ${groups.size} group(s).`,
      );
      return groups;
    } catch {
      logger.warn(
        {},
        "[lunr-recon] Failed to load cache file — rebuilding from SPARQL.",
      );
      return null;
    }
  }

  async save(groups: TypedIndex): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

      // Stream the JSON to disk instead of building one giant string in memory:
      // each Lunr index is serialized on its own, and the names one by one, so
      // the full JSON string never exists in RAM at once.
      const stream = fs.createWriteStream(this.filePath, { encoding: "utf-8" });
      const write = (chunk: string): Promise<void> =>
        new Promise((resolve, reject) => {
          stream.write(chunk, (err) => (err ? reject(err) : resolve()));
        });

      await write(`{"version":${INDEX_VERSION},"groups":{`);
      let firstGroup = true;
      for (const [key, { index, names }] of groups) {
        await write(
          `${firstGroup ? "" : ","}${JSON.stringify(key)}:{"index":${JSON.stringify(index.toJSON())},"names":{`,
        );
        let first = true;
        for (const [uri, name] of names) {
          await write(
            `${first ? "" : ","}${JSON.stringify(uri)}:${JSON.stringify(name)}`,
          );
          first = false;
        }
        await write("}}");
        firstGroup = false;
      }
      await write("}}");

      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      logger.info({}, `[lunr-recon] Index saved → "${this.filePath}"`);
    } catch {
      logger.warn({}, "[lunr-recon] Failed to save index.");
    }
  }
}
