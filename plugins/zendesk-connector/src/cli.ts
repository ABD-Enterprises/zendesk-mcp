/**
 * The command line the connector answers to.
 *
 * A flag the connector does not know is an error, not a request to serve.
 * Without this, any unrecognised argument — `--help` included — falls through
 * to the server, which then waits on stdin forever and prints nothing, so a
 * typo reads as a broken install.
 */

/** The flags the connector understands. */
export const KNOWN_FLAGS = [
  "--doctor",
  "--tools",
  "--healthcheck",
  "--logout",
] as const;

/** The flags that ask for the usage text. */
const HELP_FLAGS = ["--help", "-h"];

/** Reports whether the process was asked to print the usage. */
export function isHelpRequested(
  argv: string[] = process.argv.slice(2),
): boolean {
  return argv.some((argument) => HELP_FLAGS.includes(argument));
}

/** The flags the connector does not understand. */
export function unknownFlags(
  argv: string[] = process.argv.slice(2),
): string[] {
  const known = new Set<string>([...KNOWN_FLAGS, ...HELP_FLAGS]);
  return argv.filter(
    (argument) => argument.startsWith("-") && !known.has(argument),
  );
}

/** The usage text the `--help` flag prints. */
export function usage(): string {
  return [
    "zendesk-mcp — an MCP server for Zendesk Support.",
    "",
    "Usage:",
    "  zendesk-mcp                Serve the MCP tools over stdio.",
    "  zendesk-mcp --doctor       Check the configuration and report what is missing.",
    "  zendesk-mcp --tools        Print the configuration and the tools the agent will receive.",
    "  zendesk-mcp --healthcheck  Print one health line and exit.",
    "  zendesk-mcp --logout       Revoke the OAuth token and remove the token file.",
    "  zendesk-mcp --help         Print this message.",
    "",
    "--doctor, --tools and --healthcheck never contact Zendesk, so they are",
    "safe to run without an account. `npm run doctor` runs the preflight.",
    "",
  ].join("\n");
}
