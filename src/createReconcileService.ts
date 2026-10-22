import {
  ReconcileProjectConfig,
  ReconciliationServiceConfig,
  SparqlReconcileServiceConfig,
} from "./config/ReconcileConfig";
import { ReconcileServiceIfc } from "./interfaces/ReconcileServiceIfc";
import { ChainedReconcileService } from "./ChainedReconcileService";
import { SparqlReconcileService } from "./impl/SparqlReconcileService";
import { SparqlReconcileServiceV13 } from "./impl/SparqlReconcileServiceV13";
import { LuceneGraphDBReconcileService } from "./impl/LuceneGraphDBReconcileService";
import { LunrReconcileService } from "./impl/lunr/LunrReconcileService";
import { IsidoreApiReconcileService } from "./impl/IsidoreApiReconcileService";

const DEFAULT_RECONCILIATION_CONFIG: SparqlReconcileServiceConfig = {
  cacheSize: 1000,
  maxResults: 10,
};

/**
 * Builds the reconciliation service of a project from its config: the
 * service of its `reconciliation` section, a ChainedReconcileService when the
 * section lists several, a SparqlReconcileService when there is none.
 *
 * Each call builds a new service, with its own cache and Lunr index: the host
 * project keeps the instance it gets.
 */
export function createReconcileService(
  projectKey: string,
  projectConfig: ReconcileProjectConfig,
): ReconcileServiceIfc {
  const reconciliationRaw = projectConfig.reconciliation;
  const reconciliationList: ReconciliationServiceConfig[] = !reconciliationRaw
    ? []
    : Array.isArray(reconciliationRaw)
      ? reconciliationRaw
      : [reconciliationRaw];

  if (reconciliationList.length === 0) {
    return new SparqlReconcileService(
      projectKey,
      projectConfig.sparqlEndpoint,
      DEFAULT_RECONCILIATION_CONFIG,
      projectConfig,
    );
  }
  if (reconciliationList.length === 1) {
    return createSingleService(
      projectKey,
      projectConfig,
      reconciliationList[0],
    );
  }
  // Each service gets its own config, then they are tried in order.
  return new ChainedReconcileService(
    reconciliationList.map((cfg) =>
      createSingleService(projectKey, projectConfig, cfg),
    ),
  );
}

function createSingleService(
  projectKey: string,
  projectConfig: ReconcileProjectConfig,
  cfg: ReconciliationServiceConfig,
): ReconcileServiceIfc {
  const endpoint = projectConfig.sparqlEndpoint;
  switch (cfg.implementation) {
    case "SparqlReconcileService":
      return new SparqlReconcileService(
        projectKey,
        endpoint,
        cfg,
        projectConfig,
      );
    case "SparqlReconcileServiceV13":
      return new SparqlReconcileServiceV13(
        projectKey,
        endpoint,
        cfg,
        projectConfig,
      );
    case "LuceneGraphDBReconcileService":
      return new LuceneGraphDBReconcileService(
        projectKey,
        endpoint,
        cfg,
        projectConfig,
      );
    case "LunrReconcileService":
      return new LunrReconcileService(projectKey, endpoint, cfg, projectConfig);
    case "IsidoreApiReconcileService":
      return new IsidoreApiReconcileService();
    default:
      throw new Error(
        `Unknown reconciliation implementation "${cfg.implementation}" in project "${projectKey}"`,
      );
  }
}
