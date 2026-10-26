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
npx kgreconcile reconcile "Victor Hugo" --endpoint=SPARQL_endpoint --shacl=SHACL_file
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
