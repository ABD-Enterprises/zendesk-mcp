/**
 * A local stand-in for the small slice of the Zendesk API the console calls.
 *
 * It binds to 127.0.0.1 on an ephemeral port, answers only the token request
 * and the view execution the console makes, and records every request it saw
 * so a test can assert on them. It never talks to the internet.
 *
 * Every test starts its own account and closes it again afterwards, so the
 * recording of a test only ever holds the requests of that test. The console
 * reads the account URL from the client file when it asks for a token and
 * keeps it for the requests that follow, so a request the console sent for an
 * earlier test still points at that earlier account and can never land in the
 * recording of a later one. That matters because the dashboard reads two
 * views at the same time and answers with an error as soon as the first one
 * fails: the second request is still on its way when the test ends.
 */
import { createServer } from "node:http";

const VIEW_PATH = /^\/api\/v2\/views\/([^/]+)\/execute\.json$/;

const DEFAULT_TOKEN = {
  status: 200,
  body: { access_token: "invented-access-token", token_type: "bearer", expires_in: 3600 },
};

const DEFAULT_VIEW = { status: 200, body: { count: 0, rows: [] } };

export async function startMockZendesk() {
  const state = {
    tokenRequests: [],
    viewRequests: [],
    unknownRequests: [],
    token: { ...DEFAULT_TOKEN },
    views: new Map(),
    defaultView: { ...DEFAULT_VIEW },
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/oauth/tokens") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        state.tokenRequests.push({
          method: request.method,
          path: url.pathname,
          contentType: request.headers["content-type"],
          body,
          raw,
        });
        send(response, state.token.status, state.token.body);
      });
      return;
    }

    const view = VIEW_PATH.exec(url.pathname);
    if (request.method === "GET" && view) {
      const id = decodeURIComponent(view[1]);
      state.viewRequests.push({
        id,
        path: url.pathname,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
      });
      const configured = state.views.get(id) ?? state.defaultView;
      send(response, configured.status, configured.body);
      return;
    }

    state.unknownRequests.push({ method: request.method, path: url.pathname });
    send(response, 404, { error: "not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    // Chooses the answer of the token endpoint for the next requests.
    setTokenResponse(status, body) {
      state.token = { status, body };
    },
    // Chooses the answer of one view execution endpoint.
    setViewResponse(id, status, body) {
      state.views.set(id, { status, body });
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function send(response, status, body) {
  const payload = JSON.stringify(body ?? {});
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
