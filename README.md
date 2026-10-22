# kgreconcile

kgreconcile finds the IRIs of a knowledge graph that match labels, such as "Victor Hugo" or "paracétamol". The graph is reached through its SPARQL endpoint and described by SHACL shapes.

It is a library, used by [KGCompass](https://github.com/sparna-git/kgcompass) for its `reconcile_entities` tool and by sparnatural-services for its `/reconciliation` API. It is also a command line, to reconcile labels or build an index without starting a server.

## Command line

From a clone, after `npm install`:

```sh
npm run cli -- reconcile "Roberta Metsola" --config=config/config.yaml --project=ep
```

From a project that has kgreconcile in its dependencies:

```sh
npx kgreconcile reconcile "Roberta Metsola" --config=config/config.yaml --project=ep
```

The candidates are printed on stdout as JSON, one entry per label:

```json
{
  "Roberta Metsola": {
    "result": [
      {
        "id": "https://data.europarl.europa.eu/person/118859",
        "name": "Roberta METSOLA",
        "score": 100,
        "match": true
      }
    ]
  }
}
```

The logs go to stderr, so `> results.json` keeps the JSON alone. `--quiet` removes them.

### Commands

`reconcile <label>...` reconciles one or more labels.

- `--type=<iri>` keeps only the candidates of that type, one of the `shaclTypes` of the project (the IRIs of its NodeShapes by default).
- `--queries=<json|file>` gives the queries in the format of the reconciliation API, `{ "key": { "query": "...", "type": "..." } }`, in place of the labels. The value is a JSON object, or the path of a JSON file.
- `--include-types` adds the types of each candidate, as OpenRefine expects them. The SPARQL services fill them, `LunrReconcileService` does not.

`index` builds the Lunr index of a project and saves it to its `indexCachePath`. Without `--project`, it goes through all the projects of the config file and skips those that have no Lunr service.

- `--force` builds the index again from the SPARQL endpoint even if the file exists. Without it, an existing file is only loaded and checked.

`reconcile` builds the index too, when the project needs one and its file does not exist yet. `index` is there to do it in advance, or to refresh it after the data has changed.

### Choosing the project

With a config file:

- `--config=<file>` is the YAML file (`config.yaml` by default).
- `--project=<key>` is the project of that file. It can be left out when the file has a single project.

Without a config file, for a quick test on an endpoint:

- `--endpoint=<url>` is the SPARQL endpoint.
- `--shacl=<files>` lists the SHACL files, separated by spaces.
- `--implementation=<name>` is the service to use, `SparqlReconcileService` by default.
- `--index=<file>` is the `indexCachePath`, for `LunrReconcileService`.

```sh
npx kgreconcile reconcile "Victor Hugo" --endpoint=https://example.org/sparql --shacl=./shapes.ttl
```

The paths given in the options and in the config file are relative to the current directory.

## Config file

kgreconcile reads the `projects` section of the config files of KGCompass and sparnatural-services, and ignores the other keys:

```yaml
log:
  level: info # optional
projects:
  my-project: # projectKey
    shacl: ./config/my-project/shapes.ttl
    sparqlEndpoint: https://example.org/sparql
    reconciliation:
      implementation: LunrReconcileService
      indexCachePath: ./cache/my-project/lunr-index.json
```

| Key              | Role                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `sparqlEndpoint` | The endpoint the queries are sent to.                                                               |
| `shacl`          | The SHACL files that describe the graph. Several paths are separated by spaces.                     |
| `shaclTypes`     | Optional. The values accepted by the `type` of a query. Defaults to the IRIs of all the NodeShapes. |
| `reconciliation` | Optional. One service, or a list of services tried in order until one returns candidates.           |

The services, to put in `implementation`:

- `SparqlReconcileService`: exact match on the labels, with SPARQL queries. Used when `reconciliation` is absent.
- `SparqlReconcileServiceV13`: the same, for the v13 structure of the Sparnatural queries.
- `LunrReconcileService`: prefix and fuzzy search in a Lunr index, built from the queries listed in `sparqlQueries`.
- `LuceneGraphDBReconcileService`: search through a Lucene connector of GraphDB, named by `luceneIndexName`.
- `IsidoreApiReconcileService`: calls the suggest API of ISIDORE.

They accept `cacheSize` and `maxResults`, except the last one.

### Lunr index

```yaml
reconciliation:
  implementation: LunrReconcileService
  maxResults: 6
  indexCachePath: ./cache/ep/lunr-index.json
  sparqlQueries:
    - field: label
      boost: 10
      queryFiles:
        - ./config/ep/sparqlqueriesindex/rdfs_label.rq
        - ./config/ep/sparqlqueriesindex/skos_prefLabel.rq
    - field: altLabel
      boost: 5
      queryFile: ./config/ep/sparqlqueriesindex/skos_altLabel.rq
```

Each query returns `?entity ?value` rows, and each value is indexed in the field of its query. A field takes one query (`query`, inline), one file (`queryFile`) or several (`queryFiles`). Without `sparqlQueries`, the index holds the `rdfs:label` in French or without a language.

The first use builds the index from the SPARQL endpoint and saves it in `indexCachePath`. The next ones load that file. Delete it, or run `index --force`, to build it again. Without `indexCachePath`, the index is built in memory at each start.

A large index needs memory: the RUIM one holds 167,000 entities and takes 250 MB on disk. If Node runs out of memory, give it more with `NODE_OPTIONS=--max-old-space-size=8192`.

## Library

Add kgreconcile to the dependencies of the other project, in one of two ways.

From the npm registry, once it is published:

```sh
npm install kgreconcile
```

Or from a local copy, to use a version that is not published:

```sh
npm pack                                          # in kgreconcile, writes kgreconcile-0.1.0.tgz
npm install ../kgreconcile/kgreconcile-0.1.0.tgz  # in the other project
```

`npm pack` builds the project first. Run both commands again after a change in kgreconcile: as long as the version stays 0.1.0, a plain `npm install` keeps the old copy.

```ts
import { createReconcileService, warmUpLunrIndexes } from "kgreconcile";

// the config of one project, as in the "projects" section above
const service = createReconcileService("my-project", projectConfig);

const output = await service.reconcileQueries(
  { q0: { query: "Victor Hugo" } },
  false, // includeTypes
);

// once at startup, so that the first call does not wait for the index
warmUpLunrIndexes({ "my-project": service });
```

`createReconcileService` builds a new service at each call, with its own cache and its own index. Keep the instance and reuse it.

kgreconcile does not read any config file by itself: the host project passes the config of each project. `loadConfigFile(path)` reads a YAML file in the format above, for a project that has none of its own. `setLogLevel(level)` sets the level of the logs, `info` by default.

## Build

- `npm run build` compiles to `dist`.
- `npm run cli -- <command>` runs the command line from the sources, with ts-node.
