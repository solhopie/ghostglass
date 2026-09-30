import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the package version at runtime so --version can never drift from
 * package.json. Walks up from the compiled module to find the owning
 * package.json (the dist/ layout puts compiled files several levels
 * below the package root). Falls back to "0.0.0-dev" if unreachable.
 */
export function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = require(join(dir, "package.json")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === "ghostglass" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // not here — keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}
