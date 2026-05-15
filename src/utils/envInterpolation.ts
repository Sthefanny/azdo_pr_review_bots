/** Replace `${ENV_NAME}` placeholders in arbitrary JSON-as-text. */

const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolateEnvInString(input: string): string {
  return input.replaceAll(TOKEN, (_, name: string): string => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
      throw new Error(`Missing environment variable referenced in config: ${name}`);
    }
    return raw;
  });
}

export function interpolateEnvInJson(rawText: string): string {
  return interpolateEnvInString(rawText).trim();
}
