import fs from "fs";
import yaml from "js-yaml";
import { ReconcileConfigFile } from "./ReconcileConfig";

/**
 * Reads a YAML config file with a `projects` section, in the format of
 * KGCompass and sparnatural-services. The paths written in it stay relative to
 * the current directory.
 */
export function loadConfigFile(configPath: string): ReconcileConfigFile {
  const content = fs.readFileSync(configPath, "utf8");
  const config = yaml.load(content) as ReconcileConfigFile | undefined;
  if (!config?.projects) {
    throw new Error(`No "projects" section in ${configPath}`);
  }
  return config;
}
