#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createHttpClient,
  ensureApiBasePath,
  getTools,
  normalizeBaseUrl,
  runTool,
} from "./freshsales-tools.js";

const API_KEY = process.env.FRESHSALES_API_KEY;
const BASE_URL = ensureApiBasePath(
  normalizeBaseUrl(process.env.FRESHSALES_BASE_URL || ""),
);

if (!API_KEY || !BASE_URL) {
  console.error("Missing required env vars: FRESHSALES_API_KEY and FRESHSALES_BASE_URL");
  process.exit(1);
}

const http = createHttpClient({
  apiKey: API_KEY,
  baseUrl: BASE_URL,
});

const toToolResult = (data) => ({
  content: [{ type: "json", json: data }],
});

async function main() {
  const server = new Server(
    {
      name: "freshsales-basic-mcp",
      version: "2.2.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      const result = await runTool(http, name, args);
      return toToolResult(result);
    } catch (error) {
      const message = error.response?.data ?? error.message;
      return toToolResult({ success: false, error: message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Freshsales Basic MCP Server (v2.2.0) running...");
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
