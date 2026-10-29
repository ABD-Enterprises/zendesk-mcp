import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import type { ZendeskConfig } from "./auth.js";
import { checkDoctor, isDoctorRequested, runDoctor } from "./doctor.js";

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
  return { ...env, ...extra };
}

test("detects the doctor flag", () => {
  assert.equal(isDoctorRequested(["--doctor"]), true);
  assert.equal(isDoctorRequested(["--healthcheck"]), false);
  assert.equal(isDoctorRequested([]), false);
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
  assert.deepEqual(out, ["Zendesk connector doctor: all checks passed.\n"]);
  assert.deepEqual(err, []);
});

test("reports configuration and tool-policy problems together", async () => {
  const configMessage =
    "Zendesk connector is not configured. Set ZENDESK_SUBDOMAIN or ZENDESK_BASE_URL.";
  process.env.ZENDESK_READ_ONLY = "yes";
  const { calls, probe } = probeRecorder(true);
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
  const { calls, probe } = probeRecorder(true);

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
  const { calls, probe } = probeRecorder(false);

  const problems = await checkDoctor({
    loadConfig: () =>
      config({ mode: "authorization_code", tokenFile: join(directory, "oauth.json") }),
    probePort: probe,
  });

  assert.deepEqual(calls, [3219]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /cannot listen on port 3219/);
  assert.match(problems[1], /Run npm run oauth:setup/);
});

test("reports an unusable callback port without probing it", async () => {
  const directory = await tempDir();
  process.env.ZENDESK_OAUTH_CALLBACK_PORT = "not-a-port";
  const { calls, probe } = probeRecorder(true);

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
    JSON.stringify({ access_token: "invented-access-token" }),
  );
  await chmod(tokenFile, 0o644);
  const { calls, probe } = probeRecorder(true);

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probe,
  });

  assert.deepEqual(calls, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /OAuth token file .* must be readable only by its owner \(chmod 600\)/);
});

test("reports a token file that does not parse", async () => {
  const tokenFile = await tempTokenFile("{not json");

  const problems = await checkDoctor({
    loadConfig: () => config({ mode: "authorization_code", tokenFile }),
    probePort: probeRecorder(true).probe,
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
    probePort: probeRecorder(true).probe,
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not contain an access_token/);
});

test("reports a token file without a refresh token", async () => {
  const tokenFile = await tempTokenFile(
    JSON.stringify({ access_token: "invented-access-token" }),
  );
  const { calls, probe } = probeRecorder(true);

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

test("probes the port when the stored token is unusable", async () => {
  const tokenFile = await tempTokenFile("{not json");
  const { calls, probe } = probeRecorder(false);

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

  const result = await runEntry(["--doctor"], {
    ...cleanEnv({
      ZENDESK_OAUTH_CLIENT_FILE: clientFile,
      ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
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

test("the default probe reports a free port as free", async () => {
  const directory = await tempDir();
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

  assert.equal(problems.length, 1);
  assert.match(problems[0], /Run npm run oauth:setup/);
  assert.ok(!problems[0].includes("cannot listen on port"));
});

test("skips the token and port checks outside authorization_code mode", async () => {
  const { calls, probe } = probeRecorder(true);

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

test("passes against a real authorization-code configuration", async () => {
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
  process.env = cleanEnv({
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
  });
  const out: string[] = [];
  const err: string[] = [];

  const code = await runDoctor({
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.deepEqual(out, ["Zendesk connector doctor: all checks passed.\n"]);
  assert.deepEqual(err, []);
});

test("never prints configuration values", async () => {
  const out: string[] = [];
  const err: string[] = [];

  await runDoctor({
    loadConfig: () => config(),
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

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

function probeRecorder(result: boolean): {
  calls: number[];
  probe: (port: number) => Promise<boolean>;
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

/** Creates a temporary fixture directory that `afterEach` removes. */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-doctor-test-"));
  tempDirs.push(directory);
  return directory;
}
