import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import type { ZendeskConfig } from "./auth.js";
import {
  checkDoctor,
  isDoctorRequested,
  isToolsRequested,
  runDoctor,
} from "./doctor.js";
import type { PortProbeResult } from "./doctor.js";

const originalEnv = { ...process.env };
// Temporary fixture directories are tracked so each test removes its own.
const tempDirs: string[] = [];
// The doctor validates the tool policy and reads the callback port; ambient
// values would make these tests depend on the host environment.
function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...originalEnv };
  delete env.ZENDESK_ALLOWED_TOOLS;
  delete env.ZENDESK_READ_ONLY;
  delete env.ZENDESK_OAUTH_CALLBACK_PORT;
  return env;
}
delete process.env.ZENDESK_ALLOWED_TOOLS;
delete process.env.ZENDESK_READ_ONLY;
delete process.env.ZENDESK_OAUTH_CALLBACK_PORT;

afterEach(async () => {
  process.env = { ...hostEnv() };
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** The host environment without any account configuration. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = hostEnv();
  delete env.ZENDESK_SUBDOMAIN;
  delete env.ZENDESK_BASE_URL;
  delete env.ZENDESK_OAUTH_MODE;
  delete env.ZENDESK_OAUTH_CLIENT_ID;
  delete env.ZENDESK_OAUTH_CLIENT_SECRET;
  delete env.ZENDESK_OAUTH_ACCESS_TOKEN;
  delete env.ZENDESK_OAUTH_CLIENT_FILE;
  delete env.ZENDESK_OAUTH_TOKEN_FILE;
  // The mode must come from the arguments a spawn test passes, never from a
  // ZENDESK_HEALTHCHECK shortcut exported on the host.
  delete env.ZENDESK_HEALTHCHECK;
  return { ...env, ...extra };
}

test("detects the doctor flag", () => {
  assert.equal(isDoctorRequested(["--doctor"]), true);
  assert.equal(isDoctorRequested(["--healthcheck"]), false);
  assert.equal(isDoctorRequested([]), false);
});

test("detects the inventory flag", () => {
  assert.equal(isToolsRequested(["--tools"]), true);
  assert.equal(isToolsRequested(["--doctor", "--tools"]), true);
  assert.equal(isToolsRequested(["--doctor"]), false);
  assert.equal(isToolsRequested([]), false);
});

test("prints the resolved configuration and the enabled tools on request", async () => {
  const out: string[] = [];
  const err: string[] = [];

  const code = await runDoctor({
    loadConfig: () => config(),
    tools: true,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  const printed = out.join("");
  assert.match(printed, /Base URL: https:\/\/example\.zendesk\.com/);
  assert.match(printed, /OAuth mode: access_token/);
  assert.match(printed, /Scope: read write/);
  // The operator can see what the agent will receive without starting it.
  assert.match(printed, /Enabled tools \(12 of 12\): zendesk_add_ticket_comment/);
  // Nothing printed carries a credential, on this surface as on the others.
  assert.ok(!printed.includes("invented-access-token"));
  assert.ok(!printed.includes("invented-client-secret"));
  assert.ok(!printed.includes("invented-client-id"));
  assert.deepEqual(err, []);
});

test("the inventory still prints the configuration when the tool policy is broken", async () => {
  const previous = process.env.ZENDESK_ALLOWED_TOOLS;
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_not_a_tool";
  const out: string[] = [];
  const err: string[] = [];

  try {
    await runDoctor({
      loadConfig: () => config(),
      tools: true,
      writeOut: (line) => out.push(line),
      writeError: (line) => err.push(line),
    });
  } finally {
    if (previous === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
    else process.env.ZENDESK_ALLOWED_TOOLS = previous;
  }

  const printed = out.join("");
  // The tool policy is broken, but the configuration is what the operator
  // asked for, so it is printed anyway.
  assert.match(printed, /Base URL: https:\/\/example\.zendesk\.com/);
  assert.match(printed, /The enabled tools could not be resolved\./);
});

test("names the read-only tool set in the inventory", async () => {
  const previous = process.env.ZENDESK_READ_ONLY;
  process.env.ZENDESK_READ_ONLY = "1";
  const out: string[] = [];

  try {
    await runDoctor({
      loadConfig: () => config(),
      tools: true,
      writeOut: (line) => out.push(line),
      writeError: () => {},
    });
  } finally {
    if (previous === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = previous;
  }

  assert.match(out.join(""), /Enabled tools \(9 of 12\)/);
  assert.ok(!out.join("").includes("zendesk_update_ticket"));
});

test("prints one all-clear line to stdout and exits zero", async () => {
  const out: string[] = [];
  const err: string[] = [];

  const code = await runDoctor({
    loadConfig: () => config(),
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  // The access-token mode has no token file, so there is no path to name.
  assert.deepEqual(out, ["Zendesk connector doctor: all checks passed.\n"]);
  assert.deepEqual(err, []);
});

test("reports configuration and tool-policy problems together", async () => {
  const configMessage =
    "Zendesk connector is not configured. Set ZENDESK_SUBDOMAIN or ZENDESK_BASE_URL.";
  process.env.ZENDESK_READ_ONLY = "yes";
  const { calls, probe } = probeRecorder("free");
  const out: string[] = [];
  const err: string[] = [];

  const code = await runDoctor({
    loadConfig: () => {
      throw new Error(configMessage);
    },
    probePort: probe,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.equal(err.length, 2);
  assert.equal(err[0], `${configMessage}\n`);
  assert.match(err[1], /ZENDESK_READ_ONLY must be 1, true, 0, or false/);
  // The port and token checks depend on the configuration, so they are skipped
  // instead of repeating what the configuration line already said.
  assert.deepEqual(calls, []);
});

test("reports an invalid read-only flag on its own", async () => {
  process.env.ZENDESK_READ_ONLY = "yes";

  const problems = await checkDoctor({ loadConfig: () => config() });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /ZENDESK_READ_ONLY must be 1, true, 0, or false/);
});

test("asks for oauth:setup when the token file is missing and the port is free", async () => {
  const directory = await tempDir();
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probe,
  });

  assert.deepEqual(calls, [3219]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Unable to read OAuth token file .*oauth\.json/);
  assert.match(problems[0], /Run npm run oauth:setup/);
});

test("reports a busy callback port before the missing token file", async () => {
  const directory = await tempDir();
  const { calls, probe } = probeRecorder("in-use");

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probe,
  });

  assert.deepEqual(calls, [3219]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /cannot listen on port 3219/);
  assert.match(problems[0], /another process holds the port/);
  assert.match(problems[1], /Run npm run oauth:setup/);
});

test("reports a port this user cannot bind with its own advice", async () => {
  const directory = await tempDir();
  const { calls, probe } = probeRecorder({ errno: "EACCES" });

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probe,
  });

  // A bind refusal is not evidence of an earlier setup still waiting: only a
  // port another process holds gets the "earlier setup" advice. On this
  // high default port privileges are irrelevant, so the report must not
  // blame them either — that advice belongs only to ports below 1024. The
  // OS errno rides along so the report carries the refusal's own cause.
  assert.deepEqual(calls, [3219]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /cannot listen on port 3219: this user cannot bind the port/);
  assert.match(problems[0], /the OS refused the bind attempt, errno EACCES/);
  assert.ok(!problems[0].includes("earlier setup"));
  assert.ok(!problems[0].includes("elevated privileges"));
  assert.match(problems[1], /Run npm run oauth:setup/);

  // A probe that could not report an errno still produces the same advice,
  // just without the detail.
  const withoutErrno = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probeRecorder({}).probe,
  });

  assert.match(withoutErrno[0], /the OS refused the bind attempt\)\./);
  assert.ok(!withoutErrno[0].includes("errno"));

  // Descriptor exhaustion is also a bind refusal, and its report must not
  // invent a cause: the clause names none, and the errno carries the OS's own
  // answer (EMFILE here — not privileges, a sandbox, or "to this user").
  const exhausted = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probeRecorder({ errno: "EMFILE" }).probe,
  });

  assert.match(exhausted[0], /the OS refused the bind attempt, errno EMFILE/);
  assert.ok(!exhausted[0].includes("refused it to this user"));
  assert.ok(!exhausted[0].includes("elevated privileges"));
});

test("reports an unusable callback port without probing it", async () => {
  const directory = await tempDir();
  process.env.ZENDESK_OAUTH_CALLBACK_PORT = "not-a-port";
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535/);
  assert.match(problems[1], /Run npm run oauth:setup/);
});

test("reports a non-decimal callback port without probing it", async () => {
  const directory = await tempDir();
  // Number("0x10") would silently become 16: the port must be written the
  // way the error message describes it, or setup and the doctor would bind
  // a port nobody registered as the callback URL.
  process.env.ZENDESK_OAUTH_CALLBACK_PORT = "0x10";
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535/);
  assert.match(problems[1], /Run npm run oauth:setup/);
});

test("reports a token file readable by other users without probing the port", async () => {
  const tokenFile = await tempTokenFile(
    JSON.stringify({
      access_token: "invented-access-token",
      refresh_token: "invented-refresh-token",
    }),
  );
  await chmod(tokenFile, 0o644);
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  // Node reports synthetic permission bits on Windows, so the check is
  // skipped there instead of failing every run — and with a complete token
  // stored, that run has nothing else to report.
  assert.deepEqual(
    problems,
    process.platform === "win32"
      ? []
      : [
          `OAuth token file ${tokenFile} must be readable only by its owner (chmod 600).`,
        ],
  );
});

test("reports a token file this user cannot open without probing the port", async (ctx) => {
  // stat succeeds and the group/other bits are clear, so only the open
  // itself fails: the access problem is the report's subject, and re-running
  // oauth:setup is not its remedy — the port a re-run would need stays
  // unprobed. The refusal this asserts exists on neither host that ignores
  // mode bits: Node's chmod does not block reads for the owner on Windows,
  // and root bypasses them entirely.
  if (process.platform === "win32") {
    ctx.skip("read enforcement for chmod 000 is a POSIX behavior");
    return;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    ctx.skip("root bypasses file mode bits");
    return;
  }
  const tokenFile = await tempTokenFile(
    JSON.stringify({
      access_token: "invented-access-token",
      refresh_token: "invented-refresh-token",
    }),
  );
  await chmod(tokenFile, 0o000);
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(problems, [
    `Unable to read OAuth token file ${tokenFile}. Check that the path exists and this user can access it.`,
  ]);
});

test("reports a token path that cannot be stat'd without probing the port", async () => {
  const directory = await tempDir();
  // A file where a directory belongs makes stat fail with ENOTDIR rather than
  // ENOENT: re-running oauth:setup cannot fix the path, so the message points
  // at the path itself and the port a setup re-run would need is not probed.
  const blocker = join(directory, "not-a-directory");
  await writeFile(blocker, "invented-content");
  const tokenFile = join(blocker, "oauth.json");
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Unable to read OAuth token file .*oauth\.json\. Check that the path exists and this user can access it\./);
});

test("reports a token path that is not a regular file without probing the port", async () => {
  const directory = await tempDir();
  // stat succeeds but reports a directory: re-running oauth:setup would not
  // replace it with a file, so the message names the file state itself and
  // the port a setup re-run would need is not probed.
  const tokenFile = join(directory, "oauth.json");
  await mkdir(tokenFile);
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(problems, [`OAuth token file ${tokenFile} is not a regular file.`]);
});

test("reports a token path that is the OAuth client file without probing the port", async () => {
  const directory = await tempDir();
  // Both variables naming one file is the setup trap: oauth:setup's atomic
  // write would replace the client credentials with the token. The remedy is
  // fixing the path, not re-running setup, so the port is not probed.
  const clientFile = join(directory, "client.json");
  await writeFile(clientFile, JSON.stringify({ subdomain: "example" }), {
    mode: 0o600,
  });
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile: clientFile }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(problems, [
    `OAuth token file ${clientFile} is the OAuth client file. Set ZENDESK_OAUTH_TOKEN_FILE to a different path, or fix the client file's tokenFile field; oauth:setup would overwrite the client credentials.`,
  ]);
});

test("reports a token path that is a case-variant of the client file", async (ctx) => {
  const directory = await tempDir();
  // On a case-insensitive volume the two spellings are one file, and setup's
  // atomic rename to the variant would replace the client credentials — the
  // same trap the exact-path guard catches. The probe decides whether this
  // host's volume folds case, so the assertion holds wherever the test runs.
  const clientFile = join(directory, "client.json");
  await writeFile(clientFile, JSON.stringify({ subdomain: "example" }), {
    mode: 0o600,
  });
  const variant = join(directory, "Client.json");
  try {
    statSync(variant);
  } catch (error) {
    // Only "no such file" means this volume folds case; anything else is
    // the host acting up and must surface, not silently shrink coverage.
    if ((error as { code?: string }).code === "ENOENT") {
      ctx.skip("this volume is case-sensitive");
      return;
    }
    throw error;
  }
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile: variant }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(problems, [
    `OAuth token file ${variant} is the OAuth client file. Set ZENDESK_OAUTH_TOKEN_FILE to a different path, or fix the client file's tokenFile field; oauth:setup would overwrite the client credentials.`,
  ]);
});

test("reports a client file whose tokenFile is not a path string", async () => {
  const directory = await tempDir();
  // A JSON value of the wrong type is a configuration error like any other:
  // the entry point must print one actionable line and exit 1 — not crash
  // with a raw TypeError — and the checks that depend on the configuration
  // are skipped along with it.
  const clientFile = join(directory, "client.json");
  await writeFile(
    clientFile,
    JSON.stringify({
      subdomain: "example",
      clientId: "invented-client-id",
      clientSecret: "invented-client-secret",
      mode: "authorization_code",
      tokenFile: 123,
    }),
    { mode: 0o600 },
  );

  const result = await runEntry(["--doctor"], {
    ...cleanEnv({ ZENDESK_OAUTH_CLIENT_FILE: clientFile }),
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /OAuth client configuration .*client\.json has a "tokenFile" value that must be a non-empty path string\./);
  assert.ok(!result.stderr.includes("TypeError"));
  assert.ok(!result.stderr.includes("cannot listen on port"));
});

test("reports a client file whose baseUrl is not a string", async () => {
  const directory = await tempDir();
  // The same fail-safe as a wrong-typed tokenFile: one actionable line and
  // exit 1 instead of a raw TypeError from the base-URL validation.
  const clientFile = join(directory, "client.json");
  await writeFile(
    clientFile,
    JSON.stringify({ baseUrl: 123 }),
    { mode: 0o600 },
  );

  const result = await runEntry(["--doctor"], {
    ...cleanEnv({ ZENDESK_OAUTH_CLIENT_FILE: clientFile }),
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /OAuth client configuration .*client\.json has a "baseUrl" value that must be a string\./);
  assert.ok(!result.stderr.includes("TypeError"));
});

test("reports a token file that does not parse", async () => {
  const tokenFile = await tempTokenFile("{not json");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probeRecorder("free").probe,
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /Unable to read OAuth token file .* Run npm run oauth:setup/);
});

test("reports a token file without an access token", async () => {
  const tokenFile = await tempTokenFile(
    JSON.stringify({ refresh_token: "invented-refresh-token" }),
  );

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probeRecorder("free").probe,
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not contain an access_token/);
});

test("reports a token file without a refresh token", async () => {
  const tokenFile = await tempTokenFile(
    JSON.stringify({ access_token: "invented-access-token" }),
  );
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  // Renewal throws this exact message once the access token expires, so the
  // doctor reports it now — and the port a setup re-run needs is probed.
  assert.deepEqual(calls, [3219]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /No refresh token found in .* Run npm run oauth:setup/);
});

test("reports token fields that are not strings as missing", async () => {
  // A JSON true would satisfy a truthiness check and then be sent as a
  // credential, so both fields must be reported with the messages the
  // server's own validation uses.
  const withBooleanAccess = await tempTokenFile(
    JSON.stringify({ access_token: true, refresh_token: true }),
  );
  const { calls, probe } = probeRecorder("free");

  const accessProblems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile: withBooleanAccess }),
    probePort: probe,
  });

  assert.deepEqual(calls, [3219]);
  assert.equal(accessProblems.length, 1);
  assert.match(accessProblems[0], /does not contain an access_token/);

  const withNumberRefresh = await tempTokenFile(
    JSON.stringify({ access_token: "invented-access-token", refresh_token: 5 }),
  );

  const refreshProblems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile: withNumberRefresh }),
    probePort: probe,
  });

  assert.equal(refreshProblems.length, 1);
  assert.match(refreshProblems[0], /No refresh token found in .* Run npm run oauth:setup/);
});

test("probes the port when the stored token is unusable", async () => {
  const tokenFile = await tempTokenFile("{not json");
  const { calls, probe } = probeRecorder("in-use");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  // The remedy for an unusable token is re-running setup, so the port setup
  // would need is reported as busy even though a token file exists.
  assert.deepEqual(calls, [3219]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /cannot listen on port 3219/);
  assert.match(problems[1], /Run npm run oauth:setup/);
});

test("reports a read-only allowlist that names a write tool", async () => {
  process.env.ZENDESK_READ_ONLY = "1";
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_status,zendesk_create_ticket";

  const problems = await checkDoctor({ loadConfig: () => config() });

  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /ZENDESK_READ_ONLY conflicts with write tools in ZENDESK_ALLOWED_TOOLS: zendesk_create_ticket/,
  );
});

test("an explicit --doctor flag wins over the healthcheck environment variable", async () => {
  const files = await writeAuthFiles();

  const result = await runEntry(["--doctor"], {
    ...cleanEnv({
      ZENDESK_OAUTH_CLIENT_FILE: files.clientFile,
      ZENDESK_OAUTH_TOKEN_FILE: files.tokenFile,
      ZENDESK_HEALTHCHECK: "1",
    }),
  });

  // Without the flag precedence the host's ZENDESK_HEALTHCHECK=1 would make
  // the process print a healthcheck result and skip the doctor entirely.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Zendesk connector doctor: all checks passed/);
  assert.ok(!result.stdout.includes("healthcheck"));
  assert.equal(result.stderr, "");
});

test("runs the healthcheck from the environment variable alone", async () => {
  const files = await writeAuthFiles();

  const result = await runEntry([], {
    ...cleanEnv({
      ZENDESK_OAUTH_CLIENT_FILE: files.clientFile,
      ZENDESK_OAUTH_TOKEN_FILE: files.tokenFile,
      ZENDESK_HEALTHCHECK: "1",
    }),
  });

  // The branch index.ts selects when no flag is present: on its own the
  // shortcut must select the healthcheck, not start the server.
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { healthcheck: "ok" });
  assert.equal(result.stderr, "");
});

test("an explicit --healthcheck flag wins over --doctor in either order", async () => {
  const files = await writeAuthFiles();
  const env = cleanEnv({
    ZENDESK_OAUTH_CLIENT_FILE: files.clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: files.tokenFile,
  });

  // The documented order is a precedence, not an argv order: whichever way
  // the two flags are written, the healthcheck runs.
  for (const args of [
    ["--healthcheck", "--doctor"],
    ["--doctor", "--healthcheck"],
  ]) {
    const result = await runEntry(args, env);

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { healthcheck: "ok" });
    assert.equal(result.stderr, "");
  }
});

test("an explicit --logout flag wins over the healthcheck environment variable", async () => {
  const directory = await tempDir();
  const clientFile = join(directory, "missing-client.json");
  const tokenFile = join(directory, "missing-oauth.json");

  const result = await runEntry(["--logout"], {
    ...cleanEnv({
      ZENDESK_OAUTH_CLIENT_FILE: clientFile,
      ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
      ZENDESK_HEALTHCHECK: "1",
    }),
  });

  // The shortcut would print a healthcheck result and skip the logout. With
  // the explicit flag the logout runs instead; the unloadable configuration
  // stops it before any request, so nothing leaves the machine.
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Zendesk OAuth logout incomplete/);
  assert.match(result.stderr, /Unable to read OAuth client configuration/);
  assert.ok(!result.stderr.includes('"healthcheck"'));
});

test("the default probe reports a free port as free", async () => {
  const directory = await tempDir();
  // Another process can take the OS-assigned port between the close and the
  // doctor's bind, so a stolen port retries with a fresh one instead of
  // failing a run that only lost a race.
  for (let attempt = 1; ; attempt++) {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address === "object");
    // Close the listener first: the port the OS assigned is now free, and the
    // doctor's real loopback bind must report it as such.
    await new Promise((resolve) => listener.close(resolve));
    process.env.ZENDESK_OAUTH_CALLBACK_PORT = String(address.port);

    // No probePort: the real bind path, including its success branch.
    const problems = await checkDoctor({
      loadConfig: () =>
        config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    });

    const stolen = problems.some((line) => line.includes("cannot listen on port"));
    if (stolen && attempt < 3) continue;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Run npm run oauth:setup/);
    assert.ok(!stolen, `port ${address.port} was stolen in the probe window`);
    return;
  }
});

test("skips the token and port checks outside authorization_code mode", async () => {
  const { calls, probe } = probeRecorder("free");

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "client_credentials", tokenFile: "/unused/oauth.json" }),
    probePort: probe,
  });

  assert.deepEqual(problems, []);
  assert.deepEqual(calls, []);
});

test("the default probe reports a port that is genuinely in use", async () => {
  const directory = await tempDir();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  process.env.ZENDESK_OAUTH_CALLBACK_PORT = String(address.port);

  try {
    // No probePort: the real loopback bind must report the busy port.
    const problems = await checkDoctor({
      loadConfig: () =>
        config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    });

    assert.equal(problems.length, 2);
    assert.match(problems[0], new RegExp(`cannot listen on port ${address.port}`));
    assert.match(problems[1], /Run npm run oauth:setup/);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test("the default probe reports a port this user cannot bind", async (ctx) => {
  // Observe port 1 first: some kernels let an ordinary user bind privileged
  // ports, and a port another process already holds would report a different
  // cause. Proceed only when the host genuinely refuses the bind, so this
  // assertion holds wherever the test runs.
  const observed = await bindAttempt(1);
  if (typeof observed !== "object") {
    ctx.skip(`port 1 is ${observed} on this host, not refused`);
    return;
  }
  const directory = await tempDir();
  process.env.ZENDESK_OAUTH_CALLBACK_PORT = "1";

  // No probePort: the real bind must distinguish a refusal that is not
  // EADDRINUSE — the OS rejects a privileged port for an ordinary user —
  // instead of blaming another process for it.
  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
  });

  assert.equal(problems.length, 2);
  assert.match(problems[0], /cannot listen on port 1: this user cannot bind the port/);
  assert.match(problems[0], /elevated privileges/);
  assert.ok(!problems[0].includes("another process holds"));
  assert.match(problems[1], /Run npm run oauth:setup/);
});

test("passes against a real authorization-code configuration", async () => {
  const files = await writeAuthFiles();
  process.env = cleanEnv({
    ZENDESK_OAUTH_CLIENT_FILE: files.clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: files.tokenFile,
  });
  const out: string[] = [];
  const err: string[] = [];

  const code = await runDoctor({
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  // The doctor names the token file, so the operator can find the token the
  // tool result no longer points at.
  assert.deepEqual(out, [
    "Zendesk connector doctor: all checks passed.\n",
    `OAuth token file: ${files.tokenFile}\n`,
  ]);
  assert.deepEqual(err, []);
});

test("never prints configuration values", async () => {
  const directory = await tempDir();
  const out: string[] = [];
  const err: string[] = [];

  // A failing run, not a passing one: the problem lines are the only output
  // that could carry a value, so the configuration holds invented secrets
  // while the token file the report is about is missing.
  await runDoctor({
    loadConfig: () =>
      config({
        mode: "authorization_code",
        tokenFile: join(directory, "oauth.json"),
      }),
    probePort: probeRecorder("free").probe,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  // Prove a problem line was actually printed; otherwise the leak assertions
  // below would hold vacuously.
  assert.equal(err.length, 1);
  assert.match(err[0], /Run npm run oauth:setup/);
  const printed = [...out, ...err].join("");
  assert.ok(!printed.includes("invented-access-token"));
  assert.ok(!printed.includes("invented-client-secret"));
  assert.ok(!printed.includes("invented-client-id"));
});

function config(overrides: Partial<ZendeskConfig> = {}): ZendeskConfig {
  return {
    baseUrl: "https://example.zendesk.com",
    mode: "access_token",
    accessToken: "invented-access-token",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
    tokenFile: "/unused/oauth.json",
    scope: "read write",
    ...overrides,
  };
}

function probeRecorder(result: PortProbeResult): {
  calls: number[];
  probe: (port: number) => Promise<PortProbeResult>;
} {
  const calls: number[] = [];
  return {
    calls,
    probe: async (port: number) => {
      calls.push(port);
      return result;
    },
  };
}

/**
 * Binds `port` briefly and reports what happened — the observation a test
 * uses to decide whether a host-level refusal is even present to assert on.
 */
function bindAttempt(port: number): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const attempt = createServer();
    attempt.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EADDRINUSE" ? "in-use" : { errno: error.code }),
    );
    attempt.listen(port, "127.0.0.1", () => {
      attempt.closeAllConnections();
      attempt.close();
      resolve("free");
    });
  });
}

interface EntryResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built entry point with the given arguments and environment. */
function runEntry(args: string[], env: NodeJS.ProcessEnv): Promise<EntryResult> {
  return new Promise((resolve, reject) => {
    const entry = fileURLToPath(new URL("./index.js", import.meta.url));
    const child = spawn(process.execPath, [entry, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function tempTokenFile(contents: string): Promise<string> {
  const directory = await tempDir();
  const tokenFile = join(directory, "oauth.json");
  await writeFile(tokenFile, contents, { mode: 0o600 });
  return tokenFile;
}

interface AuthFiles {
  clientFile: string;
  tokenFile: string;
}

/**
 * Writes an invented client and token pair that `authorization_code` mode
 * accepts, with owner-only permissions, into a temporary directory.
 */
async function writeAuthFiles(): Promise<AuthFiles> {
  const directory = await tempDir();
  const clientFile = join(directory, "client.json");
  const tokenFile = join(directory, "oauth.json");
  await writeFile(
    clientFile,
    JSON.stringify({
      subdomain: "example",
      clientId: "invented-client-id",
      clientSecret: "invented-client-secret",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    tokenFile,
    JSON.stringify({
      access_token: "invented-access-token",
      refresh_token: "invented-refresh-token",
    }),
    { mode: 0o600 },
  );
  return { clientFile, tokenFile };
}

/** Creates a temporary fixture directory that `afterEach` removes. */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-doctor-test-"));
  tempDirs.push(directory);
  return directory;
}
