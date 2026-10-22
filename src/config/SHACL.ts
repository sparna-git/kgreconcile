import fs from "fs";
import path from "path";

import {
  RdfStoreReader,
  ShaclModel,
  ShaclSparqlPostProcessor,
} from "rdf-shacl-commons";

const SHACL_CACHE: Record<
  string,
  Promise<{ model: ShaclModel; postProcessor: ShaclSparqlPostProcessor }>
> = {};

function listShaclPaths(shacl: string | string[] | undefined): string[] {
  if (!shacl) return [];
  return Array.isArray(shacl) ? shacl : shacl.split(/\s+/).filter(Boolean);
}

/**
 * IRIs of every NodeShape of a model: the values the reconciliation `type`
 * accepts, which `expandSparql` translates into the data at query time.
 */
export function listNodeShapeIris(model: ShaclModel): string[] {
  const iris = model
    .readAllNodeShapes()
    .map((nodeShape) => nodeShape.getResource())
    .filter((resource) => resource.termType === "NamedNode")
    .map((resource) => resource.value);
  return [...new Set(iris)];
}

/**
 * The SHACL model of a project, read from the `shacl` files of its config.
 * Cached per list of files.
 */
export function getSHACLConfig(
  projectKey: string,
  shacl: string | string[] | undefined,
): Promise<{ model: ShaclModel; postProcessor: ShaclSparqlPostProcessor }> {
  const shaclPaths = listShaclPaths(shacl);
  if (shaclPaths.length === 0) {
    return Promise.reject(
      new Error(`Aucun fichier SHACL configuré pour le projet '${projectKey}'`),
    );
  }

  const cacheKey = shaclPaths.join(" ");
  if (!SHACL_CACHE[cacheKey]) {
    SHACL_CACHE[cacheKey] = buildShaclConfig(shaclPaths).catch((err) => {
      delete SHACL_CACHE[cacheKey];
      throw err;
    });
  }
  return SHACL_CACHE[cacheKey];
}

async function buildShaclConfig(shaclPaths: string[]) {
  let ttlContent = "";
  for (const filePath of shaclPaths) {
    // relatif au dossier courant, comme les autres chemins du fichier de config
    const absolutePath = path.resolve(filePath.trim());
    console.log(`[SHACL] Lecture du fichier SHACL : ${absolutePath}`);
    ttlContent += fs.readFileSync(absolutePath, "utf8") + "\n";
  }

  console.log(`[SHACL] ${shaclPaths.length} fichier(s) SHACL chargé(s)`);

  // 1) Construire le store RDF (type laissé en ANY)
  const store: any = await new Promise((resolve) => {
    RdfStoreReader.buildStoreFromString(ttlContent, shaclPaths[0], resolve);
  });

  // 2) Skolemisation
  ShaclModel.skolemizeAnonymousPropertyShapes(store);

  // 3) Construire le modèle SHACL
  const shaclModel = new ShaclModel(store as any);

  // 4) Post-processor SPARQL
  const postProcessor = new ShaclSparqlPostProcessor(shaclModel);

  console.log(
    `[SHACL] Modèle SHACL construit (${store.countQuads(
      null,
      null,
      null,
      null,
    )} triples)`,
  );

  return { model: shaclModel, postProcessor };
}
