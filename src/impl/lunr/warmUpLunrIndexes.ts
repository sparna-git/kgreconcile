import { ChainedReconcileService } from "../../ChainedReconcileService";
import { LunrReconcileService } from "./LunrReconcileService";
import { ReconcileServiceIfc } from "../../interfaces/ReconcileServiceIfc";

/** The Lunr services of a reconciliation service, direct or chained. */
export function listLunrServices(
  service: ReconcileServiceIfc,
): LunrReconcileService[] {
  if (service instanceof LunrReconcileService) return [service];
  if (service instanceof ChainedReconcileService) {
    return service.services.filter(
      (s): s is LunrReconcileService => s instanceof LunrReconcileService,
    );
  }
  return [];
}

/**
 * Pre-warms the Lunr indexes of the given services, by project key. To be
 * called once the server is listening: until the returned promise resolves, a
 * reconciliation call waits for its index.
 */
export function warmUpLunrIndexes(
  services: Record<string, ReconcileServiceIfc>,
): Promise<void> {
  const warmUps: Promise<void>[] = [];

  for (const [projectKey, service] of Object.entries(services)) {
    for (const lunr of listLunrServices(service)) {
      console.log(`[lunr] Warming up index for project "${projectKey}"…`);
      warmUps.push(
        lunr.warmUp().catch((err) => {
          console.error(
            `[lunr] Index warm-up FAILED for project "${projectKey}":`,
            err,
          );
        }),
      );
    }
  }

  if (warmUps.length === 0) return Promise.resolve();

  return Promise.all(warmUps).then(() => {
    console.log("✅ Lunr indexes ready — reconciliation is operational");
  });
}
