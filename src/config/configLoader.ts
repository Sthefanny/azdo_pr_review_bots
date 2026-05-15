import fs from "node:fs/promises";
import path from "node:path";

import { interpolateEnvInJson } from "../utils/envInterpolation.js";
import { appConfigSchema, type AppConfig } from "./configSchema.js";

/** Load `./config/config.json` from process.cwd(), interpolate `${ENV}`, validate. */
export async function loadAppConfig(projectRoot?: string): Promise<AppConfig> {
  const root = projectRoot ?? process.cwd();
  const configPath = path.join(root, "config", "config.json");
  const rawText = await fs.readFile(configPath, "utf8");
  const interpolated = interpolateEnvInJson(rawText);
  const parsed: unknown = JSON.parse(interpolated);
  const result = appConfigSchema.safeParse(parsed);
  if (!result.success) {
    const flattened = JSON.stringify(result.error.flatten(), undefined, 2);
    throw new Error(`Invalid config at ${configPath}: ${flattened}`);
  }
  return result.data;
}

export function getEnvOrWarn(name: string): string | undefined {
  const v = process.env[name];
  return v?.length ? v : undefined;
}

/** Resolve secrets for a team; undefined if PAT missing (caller skips team with warning). */
export function resolveTeamSecrets(
  teamId: string,
  envVarName: string
): string | undefined {
  const secret = getEnvOrWarn(envVarName);
  if (!secret) {
     
    console.warn(
      `[config] Team "${teamId}" missing required environment variable: ${envVarName}`
    );
  }
  return secret;
}
