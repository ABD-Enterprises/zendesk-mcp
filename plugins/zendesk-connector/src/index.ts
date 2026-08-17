#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createZendeskServer } from "./server.js";

const server = createZendeskServer();
await server.connect(new StdioServerTransport());
