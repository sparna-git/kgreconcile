#!/usr/bin/env node
import fs from "fs";
import { parseArgs } from "util";
import { createReconcileService } from "./createReconcileService";
import { listLunrServices } from "./impl/lunr/warmUpLunrIndexes";
import { loadConfigFile } from "./config/loadConfig";
import {
  ReconcileProjectConfig,
  ReconciliationServiceConfig,
} from "./config/ReconcileConfig";
import {
  ReconcileInput,
  ReconcileServiceIfc,
} from "./interfaces/ReconcileServiceIfc";
import { SparqlReconcileService } from "./impl/SparqlReconcileService";
import { setLogLevel } from "./utils/logger";

const USAGE = `Usage: kgreconcile <command> [options]

Commands:
  reconcile <label>...     Reconcile labels to IRIs and print the candidates as JSON
  index                    Build the Lunr index of a project and save it to its indexCachePath

Project, from a config file:
  --config=<file>          YAML file with a "projects" section (default: config.yaml)
  --project=<key>          Project of the file. Optional when the file has a single
                           project. For "index", all the projects by default

Project, without a config file:
  --endpoint=<url>         SPARQL endpoint
  --shacl=<files>          SHACL files, separated by spaces
  --implementation=<name>  Reconciliation service (default: SparqlReconcileService)
  --index=<file>           indexCachePath, for LunrReconcileService

Options of "reconcile":
  --type=<iri>             Keep only the candidates of this type
  --queries=<json|file>    Queries as { "key": { "query": "...", "type": "..." } },
                           in place of the labels: a JSON object or a JSON file
  --include-types          Add the types of each candidate

Options of "index":
  --force                  Build the index from the endpoint even if its file exists

  --quiet                  No logs on stderr
  -h, --help               Show this help
`;

class UsageError extends Error {}

type Options = {
  config?: string;
  project?: string;
  endpoint?: string;
  shacl?: string;
  implementation?: string;
  index?: string;
  type?: string;
  queries?: string;
  "include-types"?: boolean;
  force?: boolean;
  quiet?: boolean;
  help?: boolean;
};

// The services log with console.log: stdout is kept for the results.
console.log = console.info = console.debug = console.error;

function silenceLogs(): void {
  setLogLevel("silent");
  console.log = console.info = console.debug = console.warn = () => {};
}

/** The projects the command works on, as [projectKey, projectConfig]. */
function resolveProjects(
  options: Options,
  allByDefault: boolean,
): [string, ReconcileProjectConfig][] {
  if (options.endpoint) {
    const reconciliation = {
      implementation: options.implementation ?? "SparqlReconcileService",
      ...(options.index ? { indexCachePath: options.index } : {}),
    } as ReconciliationServiceConfig;
    return [
      [
        options.project ?? "cli",
        {
          sparqlEndpoint: options.endpoint,
          shacl: options.shacl,
          reconciliation,
        },
      ],
    ];
  }

  const configPath = options.config ?? "config.yaml";
  if (!fs.existsSync(configPath)) {
    throw new UsageError(
      `No config file ${configPath}: give one with --config, or a SPARQL endpoint with --endpoint.`,
    );
  }
  const config = loadConfigFile(configPath);
  if (config.log?.level && !options.quiet) setLogLevel(config.log.level);

  const keys = Object.keys(config.projects);
  if (options.project) {
    const projectConfig = config.projects[options.project];
    if (!projectConfig) {
      throw new UsageError(
        `Unknown project "${options.project}" in ${configPath}. Projects: ${keys.join(", ")}`,
      );
    }
    return [[options.project, projectConfig]];
  }
  if (keys.length === 1 || allByDefault) {
    return keys.map((key) => [key, config.projects[key]]);
  }
  throw new UsageError(
    `Choose a project of ${configPath} with --project: ${keys.join(", ")}`,
  );
}

function readQueries(options: Options, labels: string[]): ReconcileInput {
  if (options.queries) {
    const json = options.queries.trim().startsWith("{")
      ? options.queries
      : fs.readFileSync(options.queries, "utf8");
    return SparqlReconcileService.parseQueries(JSON.parse(json));
  }
  if (labels.length === 0) {
    throw new UsageError("Give at least one label to reconcile, or --queries.");
  }
  const queries: ReconcileInput = {};
  for (const label of labels) {
    queries[label] = options.type
      ? { query: label, type: options.type }
      : { query: label };
  }
  return queries;
}

async function reconcile(
  service: ReconcileServiceIfc,
  options: Options,
  labels: string[],
): Promise<void> {
  const queries = readQueries(options, labels);
  const output = await service.reconcileQueries(
    queries,
    options["include-types"] ?? false,
  );
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

async function buildIndexes(
  projectKey: string,
  service: ReconcileServiceIfc,
  force: boolean,
): Promise<void> {
  const lunrServices = listLunrServices(service);
  if (lunrServices.length === 0) {
    process.stdout.write(
      `${projectKey}: no LunrReconcileService, no index to build\n`,
    );
    return;
  }
  for (const lunr of lunrServices) {
    if (!lunr.indexCachePath) {
      console.warn(
        `${projectKey}: no indexCachePath, the index is built but not saved`,
      );
    }
    await (force ? lunr.rebuildIndex() : lunr.warmUp());
    if (!lunr.indexCachePath) {
      process.stdout.write(`${projectKey}: index built in memory\n`);
    } else if (fs.existsSync(lunr.indexCachePath)) {
      process.stdout.write(`${projectKey}: index ready in ${lunr.indexCachePath}\n`);
    } else {
      throw new Error(
        `${projectKey}: the index could not be saved to ${lunr.indexCachePath}`,
      );
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      project: { type: "string" },
      endpoint: { type: "string" },
      shacl: { type: "string" },
      implementation: { type: "string" },
      index: { type: "string" },
      type: { type: "string" },
      queries: { type: "string" },
      "include-types": { type: "boolean" },
      force: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const options = values as Options;
  const [command, ...labels] = positionals;

  if (options.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.quiet) silenceLogs();

  if (command === "reconcile") {
    const [[projectKey, projectConfig]] = resolveProjects(options, false);
    await reconcile(
      createReconcileService(projectKey, projectConfig),
      options,
      labels,
    );
  } else if (command === "index") {
    for (const [projectKey, projectConfig] of resolveProjects(options, true)) {
      await buildIndexes(
        projectKey,
        createReconcileService(projectKey, projectConfig),
        options.force ?? false,
      );
    }
  } else {
    throw new UsageError(`Unknown command "${command}".`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof UsageError || err?.code?.startsWith?.("ERR_PARSE_ARGS")) {
    console.error(`${err.message}\n\n${USAGE}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
