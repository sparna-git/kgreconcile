/**
 * What the reconciliation reads from a project of the config file. The host
 * project (KGCompass, sparnatural-services) passes its own project config,
 * which can hold other keys.
 */
export interface ReconcileProjectConfig {
  sparqlEndpoint: string;
  /** SHACL files that describe the graph: several paths separated by spaces,
   *  or a list. Relative to the current directory. */
  shacl?: string | string[];
  /** The values accepted by the `type` of a query. Defaults to the IRIs of
   *  all the NodeShapes. */
  shaclTypes?: string[];
  /** One service, or a list of services tried in order until one returns
   *  candidates. Defaults to SparqlReconcileService. */
  reconciliation?: ReconciliationServiceConfig | ReconciliationServiceConfig[];
}

/** A config file: the `projects` section, read by the command line. */
export interface ReconcileConfigFile {
  log?: {
    level?: string;
  };
  projects: Record<string, ReconcileProjectConfig>;
}

export type ReconciliationServiceConfig =
  | ({
      implementation: "SparqlReconcileService";
    } & SparqlReconcileServiceConfig)
  | ({
      implementation: "SparqlReconcileServiceV13";
    } & SparqlReconcileServiceV13Config)
  | ({
      implementation: "LuceneGraphDBReconcileService";
    } & LuceneGraphDBReconcileServiceConfig)
  | ({ implementation: "LunrReconcileService" } & LunrReconcileServiceConfig)
  | ({
      implementation: "IsidoreApiReconcileService";
    } & IsidoreApiReconcileServiceConfig)
  | { implementation: "DummyReconcileService" };

export interface SparqlReconcileServiceConfig {
  cacheSize?: number;
  maxResults?: number;
}

export interface SparqlReconcileServiceV13Config {
  cacheSize?: number;
  maxResults?: number;
}
export interface LuceneGraphDBReconcileServiceConfig {
  cacheSize?: number;
  maxResults?: number;
  luceneIndexName?: string;
}

export interface FieldQueryConfig {
  field: string;
  boost?: number;
  /** Inline SPARQL query string. Mutually exclusive with queryFile(s). */
  query?: string;
  /** Path to a single .rq file. Mutually exclusive with query. */
  queryFile?: string;
  /** Paths to multiple .rq files — all executed and bindings merged into this field. */
  queryFiles?: string[];
}

export interface LunrReconcileServiceConfig {
  cacheSize?: number;
  maxResults?: number;
  /** @deprecated use sparqlQueries instead */
  sparqlQuery?: string;
  sparqlQueries?: FieldQueryConfig[];
  indexCachePath?: string;
}

export interface IsidoreApiReconcileServiceConfig {}
