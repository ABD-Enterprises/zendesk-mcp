import express from "express";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 4177);
const root = dirname(fileURLToPath(import.meta.url));

const IDS = {
  brand: 52631583889044,
  group: 45783096553876,
  requestTypeField: 52630077421588,
  systemField: 52630054345492,
  views: {
    open: 52653419561108,
    untriaged: 52760652808852,
    aging: 52772521794708,
    requestType: 52772521855892,
  },
};

let tokenCache = { value: "", expiresAt: 0, baseUrl: "" };
let overviewCache = { value: null, expiresAt: 0 };

async function getOAuthToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache;
  }

  const path = process.env.ZENDESK_OAUTH_CLIENT_FILE ||
    join(homedir(), ".config", "codex-zendesk", "client.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const baseUrl = config.baseUrl || `https://${config.subdomain}.zendesk.com`;
  const response = await fetch(`${baseUrl}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "read write",
    }),
  });
  if (!response.ok) throw new Error(`Zendesk OAuth failed (${response.status})`);
  const payload = await response.json();
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
    baseUrl,
  };
  return tokenCache;
}

async function zendesk(path) {
  const token = await getOAuthToken();
  const response = await fetch(`${token.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token.value}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Zendesk request failed (${response.status})`);
  return response.json();
}

function bucketAge(days) {
  if (days <= 2) return "0-2 days";
  if (days <= 5) return "3-5 days";
  if (days <= 10) return "6-10 days";
  if (days <= 20) return "11-20 days";
  return "21+ days";
}

function summarize(rows, baseUrl) {
  const now = Date.now();
  const tickets = rows.map((row) => {
    const createdAt = row.created;
    const ageDays = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 86_400_000));
    return {
      id: row.ticket.id,
      subject: row.subject,
      status: String(row.status || row.ticket.status),
      createdAt,
      ageDays,
      ageBucket: bucketAge(ageDays),
      requestType: row[String(IDS.requestTypeField)] || "Unclassified",
      system: row[String(IDS.systemField)] || "Not specified",
      assigneeId: row.assignee_id,
      url: `${baseUrl}/agent/tickets/${row.ticket.id}`,
    };
  });

  const countBy = (key, order) => order.map((name) => ({
    name,
    count: tickets.filter((ticket) => ticket[key] === name).length,
  }));
  const requestOrder = [
    "Bug", "Access", "How-to question", "Data or content issue",
    "Service request", "Incident or outage", "Enhancement",
    "Other or not sure", "Unclassified",
  ];
  return {
    tickets,
    aging: countBy("ageBucket", ["0-2 days", "3-5 days", "6-10 days", "11-20 days", "21+ days"]),
    requestTypes: countBy("requestType", requestOrder),
  };
}

app.get("/api/overview", async (_request, response) => {
  try {
    if (overviewCache.value && overviewCache.expiresAt > Date.now()) {
      return response.json(overviewCache.value);
    }
    const [openView, untriagedView] = await Promise.all([
      zendesk(`/api/v2/views/${IDS.views.aging}/execute.json`),
      zendesk(`/api/v2/views/${IDS.views.untriaged}/execute.json`),
    ]);
    const auth = await getOAuthToken();
    const summary = summarize(openView.rows || [], auth.baseUrl);
    const payload = {
      connected: true,
      lastSynced: new Date().toISOString(),
      accountUrl: auth.baseUrl,
      metrics: {
        active: summary.tickets.length,
        untriaged: untriagedView.count || 0,
        unassigned: summary.tickets.filter((ticket) => !ticket.assigneeId).length,
        oldestDays: Math.max(0, ...summary.tickets.map((ticket) => ticket.ageDays)),
      },
      aging: summary.aging,
      requestTypes: summary.requestTypes,
      tickets: summary.tickets.slice(0, 8),
      views: Object.fromEntries(Object.entries(IDS.views).map(([name, id]) => [
        name,
        `${auth.baseUrl}/agent/filters/${id}`,
      ])),
    };
    overviewCache = { value: payload, expiresAt: Date.now() + 30_000 };
    response.json(payload);
  } catch (error) {
    response.status(503).json({
      connected: false,
      error: error instanceof Error ? error.message : "Zendesk is unavailable",
    });
  }
});

if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  app.use(express.static(join(root, "dist")));
  app.use((_request, response) => response.sendFile(join(root, "dist", "index.html")));
}

app.listen(port, "127.0.0.1", () => {
  console.log(`Service Operations running at http://127.0.0.1:${port}`);
});
