#!/usr/bin/env node
/**
 * GhostGlass CLI entry point.
 *
 * See what your commands are doing when you're not looking.
 */
import { main } from "./cli/program.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ghostglass: ${message}`);
  process.exit(1);
});
