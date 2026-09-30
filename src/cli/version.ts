import { createRequire } from "node:module";

/**
 * Read the package version at runtime so --version can never drift from
 * package.json. Falls back to "0.0.0-dev" if package.json is unreachable.
 */
export function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // From dist/src/cli/version.js this resolves to the repo/package root.
    const pkg = require("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}
