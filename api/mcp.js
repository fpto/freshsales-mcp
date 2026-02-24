import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
} from "../freshsales-tools.js";

const API_KEY = process.env.FRESHSALES_API_KEY;
const BASE_URL = ensureApiBasePath(
  normalizeBaseUrl(process.env.FRESHSALES_BASE_URL || ""),
);

const http = createHttpClient({
  apiKey: API_KEY,
  baseUrl: BASE_URL,
});

const toToolResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

async function createMcpServer() {
  const server = new Server(
    {
      name: "freshsales-basic-mcp-http",
      version: "2.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getTools(),
  }));

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

  return server;
}

export default async function handler(req, res) {
  if (!API_KEY || !BASE_URL) {
    return res.status(500).json({
      error:
        "Missing required env vars: FRESHSALES_API_KEY and/or FRESHSALES_BASE_URL",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Use POST.",
      },
      id: null,
    });
  }

  const server = await createMcpServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", async () => {
      await transport.close();
      await server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }

    await server.close();
  }
}
