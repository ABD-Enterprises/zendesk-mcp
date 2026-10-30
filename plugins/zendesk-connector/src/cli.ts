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
  // The MCP convention for the stdio transport, which is what the connector
  // always speaks. A host that passes it is not asking for anything else.
  "--stdio",
] as const;

/** The flags that ask for the usage text. */
export const HELP_FLAGS = ["--help", "-h"];

/** Reports whether the process was asked to print the usage. */
export function isHelpRequested(
  argv: string[] = process.argv.slice(2),
): boolean {
  return argv.some((argument) => HELP_FLAGS.includes(argument));
}

/**
 * The flags the connector does not understand.
 *
 * A bare `--` is the end-of-options marker and carries no meaning here, so
 * it is not one of the flags the connector refuses.
 */
export function unknownFlags(
  argv: string[] = process.argv.slice(2),
): string[] {
  const known = new Set<string>([...KNOWN_FLAGS, ...HELP_FLAGS]);
  return argv.filter(
    (argument) =>
      argument !== "--" &&
      argument.startsWith("-") &&
      !known.has(argument),
  );
}

/**
 * The arguments the connector does not understand.
 *
 * It takes none: every mode is a flag. An argument that is not one is a
 * typo, and starting the server for it would leave the operator waiting on
 * a process that prints nothing.
 */
export function unexpectedArguments(
  argv: string[] = process.argv.slice(2),
): string[] {
  return argv.filter((argument) => !argument.startsWith("-"));
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
    "  zendesk-mcp --stdio        Accepted and ignored; the connector always speaks stdio.",
    "  zendesk-mcp --help, -h     Print this message.",
    "",
    "--doctor, --tools and --healthcheck never contact Zendesk, so they are",
    "safe to run without an account. `npm run doctor` runs the preflight.",
    "",
    "The command takes flags only. An argument it does not know is refused",
    "rather than served.",
    "",
  ].join("\n");
}
