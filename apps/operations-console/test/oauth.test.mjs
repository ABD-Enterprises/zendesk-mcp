import assert from "node:assert/strict";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { getOAuthToken, resetCaches } from "../server.mjs";
import { startMockZendesk } from "./helpers/mock-zendesk.mjs";
import {
  ACCESS_TOKEN,
  CLIENT,
  clientFileFor,
  makeTempDir,
  removeTempDir,
  writeClientFile,
} from "./helpers/console.mjs";

const originalEnv = { ...process.env };

let mock;
let directory;

before(async () => {
  directory = await makeTempDir("operations-console-oauth-");
});

after(async () => {
  await removeTempDir(directory);
});

beforeEach(async () => {
  resetCaches();
  // Every test reads its own mock account, so the recording it asserts on
  // holds the requests of that test only.
  mock = await startMockZendesk();
  const file = await writeClientFile(directory, clientFileFor(mock.baseUrl));
  process.env.ZENDESK_OAUTH_CLIENT_FILE = file;
});

afterEach(async () => {
  await mock?.close();
  process.env = { ...originalEnv };
});

test("requests a token with the client credentials from the client file", async () => {
  const token = await getOAuthToken();

  assert.equal(mock.state.tokenRequests.length, 1);
  const [request] = mock.state.tokenRequests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/oauth/tokens");
  assert.match(request.contentType, /application\/json/);
  assert.deepEqual(request.body, {
    grant_type: "client_credentials",
    client_id: CLIENT.clientId,
    client_secret: CLIENT.clientSecret,
    scope: "read write",
  });
  assert.equal(token.value, ACCESS_TOKEN);
  assert.equal(token.baseUrl, mock.baseUrl);
});

test("keeps the token while it is valid", async () => {
  await getOAuthToken();
  await getOAuthToken();

  assert.equal(mock.state.tokenRequests.length, 1);
});

test("asks for a new token once the cache is cleared", async () => {
  await getOAuthToken();
  resetCaches();
  await getOAuthToken();

  assert.equal(mock.state.tokenRequests.length, 2);
});

test("reports the status of a failed token request", async () => {
  mock.setTokenResponse(401, { error: "invalid_client" });

  await assert.rejects(() => getOAuthToken(), /Zendesk OAuth failed \(401\)/);
  assert.equal(mock.state.tokenRequests.length, 1);
});

test("fails when the client file is not valid JSON", async () => {
  const file = await writeClientFile(directory, "{ not json");
  process.env.ZENDESK_OAUTH_CLIENT_FILE = file;

  await assert.rejects(() => getOAuthToken(), (error) => error instanceof SyntaxError);
  assert.deepEqual(mock.state.tokenRequests, []);
});

test("fails when the client file is missing", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = join(directory, "absent-client.json");

  await assert.rejects(
    () => getOAuthToken(),
    (error) => error.code === "ENOENT",
  );
  assert.deepEqual(mock.state.tokenRequests, []);
});
