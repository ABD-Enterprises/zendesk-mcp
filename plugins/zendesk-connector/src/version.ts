import { createRequire } from "node:module";

const requirePackage = createRequire(import.meta.url);

function readPackageVersion(): string {
  let packageJson: unknown;
  try {
    packageJson = requirePackage("../package.json");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read package.json to determine the connector version: ${reason}`,
    );
  }

  const version =
    typeof packageJson === "object" && packageJson !== null
      ? (packageJson as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error('package.json does not declare a string "version" field.');
  }
  return version;
}

/** The connector version, read from the package manifest at startup. */
export const PACKAGE_VERSION: string = readPackageVersion();
