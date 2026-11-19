import axios from "axios";
import https from "https";
import fs from "fs";
import lunr from "lunr";
import { FieldQueryConfig } from "../../config/ReconcileConfig";
import { getSHACLConfig, listNodeShapeIris } from "../../config/SHACL";
import {
  SparqlBinding,
  FieldBinding,
  LegacyBinding,
  TypedIndex,
  UNTYPED_GROUP,
} from "./types";
import { normalizeAccents, trimNonWord } from "./lunrPipeline";
import logger from "../../utils/logger";

/** What the queries of the config bring for one entity. */
type EntityLabels = {
  displayLabel: string | null;
  fields: Record<string, Set<string>>;
};

export class LunrIndexBuilder {
  constructor(
    private readonly projectId: string,
    private readonly sparqlEndpoint: string,
    private readonly shacl: string | string[] | undefined,
    private readonly fieldQueries: FieldQueryConfig[],
    private readonly legacySparqlQuery: string | undefined,
    private readonly fieldBoosts: Map<string, number>,
  ) {}

  /**
   * The types reconciliation can filter on: the project `shaclTypes` when the
   * YAML lists them, every NodeShape IRI otherwise.
   */
  async resolveShaclTypes(initialTypes: string[]): Promise<string[]> {
    if (initialTypes.length > 0) {
      logger.info(
        {},
        `[lunr-recon] ${initialTypes.length} SHACL type(s) from config.`,
      );
      return initialTypes;
    }
    try {
      const { model } = await getSHACLConfig(this.projectId, this.shacl);
      const shapes = listNodeShapeIris(model);
      logger.info(
        {},
        `[lunr-recon] ${shapes.length} NodeShape(s) resolved from the SHACL model.`,
      );
      return shapes;
    } catch {
      logger.info(
        {},
        `[lunr-recon] No SHACL config — type filtering disabled.`,
      );
      return [];
    }
  }

  /**
   * Builds the index of the project, one group per type: the labels come from
   * the queries of the config, the types from `loadTypesFromSparql`, then each
   * entity goes into the group of each of its types, or into the untyped
   * group, and each group gets its own Lunr index.
   */
  async build(shaclTypes: string[]): Promise<TypedIndex> {
    logger.info(
      {},
      `[lunr-recon] Building lunr index for project "${this.projectId}"`,
    );

    // 1. The labels of each entity
    const dataByUri = new Map<string, EntityLabels>();

    if (this.fieldQueries.length > 0) {
      const allBindings = await Promise.all(
        this.fieldQueries.map((fq) =>
          this.loadFieldDocuments(fq).then((bindings) => ({
            field: fq.field,
            bindings,
          })),
        ),
      );
      for (const { field, bindings } of allBindings) {
        for (const { entity, value } of bindings) {
          if (!dataByUri.has(entity))
            dataByUri.set(entity, { displayLabel: null, fields: {} });
          const entry = dataByUri.get(entity)!;
          if (!entry.fields[field]) entry.fields[field] = new Set();
          entry.fields[field].add(value);
          if (entry.displayLabel === null && field === "label")
            entry.displayLabel = value;
        }
      }
    } else {
      const rawDocs = await this.loadLegacyDocuments();
      for (const doc of rawDocs) {
        if (!dataByUri.has(doc.id))
          dataByUri.set(doc.id, { displayLabel: null, fields: {} });
        const entry = dataByUri.get(doc.id)!;
        if (doc.label) {
          if (!entry.fields.label) entry.fields.label = new Set();
          entry.fields.label.add(doc.label);
          if (entry.displayLabel === null) entry.displayLabel = doc.label;
        }
        if (doc.altLabel) {
          if (!entry.fields.altLabel) entry.fields.altLabel = new Set();
          entry.fields.altLabel.add(doc.altLabel);
        }
      }
    }

    if (dataByUri.size === 0) {
      logger.warn(
        {},
        "[lunr-recon] No documents loaded — index will be empty.",
      );
    }

    // 2. The types of each entity
    const typesByUri =
      shaclTypes.length > 0
        ? await this.loadTypesFromSparql(new Set(dataByUri.keys()), shaclTypes)
        : new Map<string, Set<string>>();

    // 3. Each entity into the group of each of its types, or the untyped group
    const members = new Map<string, string[]>();
    for (const uri of dataByUri.keys()) {
      const types = typesByUri.get(uri);
      const keys = types && types.size > 0 ? [...types] : [UNTYPED_GROUP];
      for (const key of keys) {
        if (!members.has(key)) members.set(key, []);
        members.get(key)!.push(uri);
      }
    }

    // 4. One Lunr index per group
    const groups: TypedIndex = new Map();
    for (const [key, uris] of members) {
      const names = new Map<string, string>();
      for (const uri of uris) {
        const { displayLabel, fields } = dataByUri.get(uri)!;
        names.set(
          uri,
          displayLabel ?? Object.values(fields).flatMap((s) => [...s])[0] ?? uri,
        );
      }
      groups.set(key, {
        index: this.createLunrIndex(uris, dataByUri),
        names,
      });
      logger.info(
        {},
        `[lunr-recon] Group "${key}": ${uris.length} entity(ies).`,
      );
    }

    logger.info(
      {},
      `[lunr-recon] Index built: ${dataByUri.size} entity(ies) in ${groups.size} group(s), fields: [${[...this.fieldBoosts.keys()].join(", ")}].`,
    );

    return groups;
  }

  /** The Lunr index of the given entities, one document per entity. */
  private createLunrIndex(
    uris: string[],
    dataByUri: Map<string, EntityLabels>,
  ): lunr.Index {
    const fieldBoosts = this.fieldBoosts;
    return lunr(function () {
      this.ref("id");
      // Words of the index: accents removed first, then the punctuation around
      // the word, in any alphabet. lunr.trimmer is replaced: it only knows the
      // ASCII letters and ran before the accents were removed.
      this.pipeline.remove(lunr.trimmer);
      this.pipeline.remove(lunr.stemmer);
      this.pipeline.remove(lunr.stopWordFilter);
      this.pipeline.add(normalizeAccents, trimNonWord);
      // Words of a search: no trimming here, it would remove the "*" of the
      // prefix search; the words are trimmed before, in LunrSearchEngine.sanitize.
      this.searchPipeline.remove(lunr.stemmer);
      this.searchPipeline.add(normalizeAccents);
      for (const [field, boost] of fieldBoosts) {
        this.field(field, { boost });
      }
      for (const uri of uris) {
        const doc: Record<string, string> = { id: uri };
        for (const [field, values] of Object.entries(
          dataByUri.get(uri)!.fields,
        )) {
          if (values.size > 0) doc[field] = [...values].join(" ");
        }
        this.add(doc);
      }
    });
  }

  /**
   * The types of the given entities, among `shaclTypes`.
   *
   * One `?entity a <type>` branch per type, then `expandSparql` rewrites them
   * against the data: a `sh:targetClass` becomes its class, a `sh:select`
   * becomes its own pattern. Same translation as the SPARQL and Lucene
   * services. The `BIND` keeps the type as written in the config, which
   * needs rdf-shacl-commons 0.3.7: before, the rewriting of a `sh:targetClass`
   * also hit the `BIND`.
   */
  private async loadTypesFromSparql(
    uris: Set<string>,
    shaclTypes: string[],
  ): Promise<Map<string, Set<string>>> {
    const branches = shaclTypes
      .map((t) => `  { ?entity a <${t}> . BIND(<${t}> AS ?value) }`)
      .join("\n  UNION\n");
    let query = `SELECT ?entity ?value WHERE {\n${branches}\n}`;

    try {
      const { postProcessor } = await getSHACLConfig(
        this.projectId,
        this.shacl,
      );
      query = postProcessor.expandSparql(query, {});
    } catch {
      logger.info(
        {},
        `[lunr-recon] No SHACL config — types queried without expansion.`,
      );
    }

    const bindings = await this.fetchTargetBindings(query);

    const known = new Set(shaclTypes);
    const typesByUri = new Map<string, Set<string>>();
    let unknown = 0;
    for (const b of bindings) {
      if (!b.entity || !b.value) continue;
      const uri = b.entity.value;
      if (!uris.has(uri)) continue; // no label, so not in the index
      if (!known.has(b.value.value)) {
        unknown++;
        continue;
      }
      if (!typesByUri.has(uri)) typesByUri.set(uri, new Set());
      typesByUri.get(uri)!.add(b.value.value);
    }

    logger.info(
      {},
      `[lunr-recon] Types loaded: ${bindings.length} row(s) for ${shaclTypes.length} type(s), ${typesByUri.size} entity(ies) typed.`,
    );
    if (unknown > 0) {
      logger.warn(
        {},
        `[lunr-recon] ${unknown} row(s) came back with a type that is not in shaclTypes: rdf-shacl-commons older than 0.3.7 rewrites the BIND of a sh:targetClass shape. Those entities go to the untyped group.`,
      );
    }
    return typesByUri;
  }

  /** POST for the type query: no keep-alive and IPv4, which the large type queries need. */
  private async fetchTargetBindings(query: string): Promise<SparqlBinding[]> {
    const response = await axios.post<{
      results: { bindings: SparqlBinding[] };
    }>(
      this.sparqlEndpoint,
      new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Connection: "close",
        },
        httpsAgent: new https.Agent({ keepAlive: false }),
        timeout: 60000,
        family: 4,
      },
    );
    return response.data.results.bindings;
  }

  async fetchSparqlBindings(query: string): Promise<SparqlBinding[]> {
    const response = await axios.post<{
      results: { bindings: SparqlBinding[] };
    }>(
      this.sparqlEndpoint,
      new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
        family: 4,
      },
    );
    return response.data.results.bindings;
  }

  private async resolveQueries(fq: FieldQueryConfig): Promise<string[]> {
    if (fq.query) return [fq.query];
    if (fq.queryFiles?.length)
      return Promise.all(
        fq.queryFiles.map((f) => fs.promises.readFile(f, "utf-8")),
      );
    if (fq.queryFile)
      return [await fs.promises.readFile(fq.queryFile, "utf-8")];
    throw new Error(
      `[lunr-recon] FieldQueryConfig for field "${fq.field}" has neither query nor queryFile(s).`,
    );
  }

  private async loadFieldDocuments(
    fq: FieldQueryConfig,
  ): Promise<FieldBinding[]> {
    logger.info({}, `[lunr-recon] Loading field "${fq.field}"…`);
    const queries = await this.resolveQueries(fq);
    const allBindings = await Promise.all(
      queries.map((q) => this.fetchSparqlBindings(q)),
    );
    const docs = allBindings
      .flat()
      .filter((b) => b.entity && b.value)
      .map((b) => ({ entity: b.entity.value, value: b.value.value }));
    logger.info({}, `[lunr-recon] "${fq.field}": ${docs.length} binding(s).`);
    return docs;
  }

  private async loadLegacyDocuments(): Promise<LegacyBinding[]> {
    logger.info(
      {},
      "[lunr-recon] Loading entities from SPARQL (legacy query)…",
    );
    const bindings = await this.fetchSparqlBindings(this.legacySparqlQuery!);
    const labelCount = bindings.filter((b) => b.label).length;
    const altLabelCount = bindings.filter((b) => b.altLabel).length;
    logger.info(
      {},
      `[lunr-recon] ${bindings.length} bindings — ${labelCount} with label, ${altLabelCount} with altLabel.`,
    );
    return bindings.map((b) => ({
      id: b.entity.value,
      label: b.label?.value,
      altLabel: b.altLabel?.value,
    }));
  }
}
