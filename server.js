#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const API_KEY = process.env.FRESHSALES_API_KEY;
const BASE_URL = (process.env.FRESHSALES_BASE_URL || "").replace(/\/$/, "");

if (!API_KEY || !BASE_URL) {
  console.error("Missing required env vars: FRESHSALES_API_KEY and FRESHSALES_BASE_URL");
  process.exit(1);
}

const http = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Token token=${API_KEY}`,
    "Content-Type": "application/json",
  },
});

const toToolResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

async function searchContact(query) {
  const res = await http.get("/search", {
    params: { q: query, include: "contact" },
  });

  return {
    success: true,
    query,
    results: res.data,
  };
}

async function createContact(contact) {
  const res = await http.post("/contacts", { contact });
  return {
    success: true,
    contact: res.data.contact ?? res.data,
  };
}

async function updateContact(id, contact) {
  const res = await http.put(`/contacts/${id}`, { contact });
  return {
    success: true,
    id,
    contact: res.data.contact ?? res.data,
  };
}

async function createNote(note) {
  const res = await http.post("/notes", { note });
  return {
    success: true,
    note: res.data.note ?? res.data,
  };
}

async function createDeal(deal) {
  const res = await http.post("/deals", { deal });
  return {
    success: true,
    deal: res.data.deal ?? res.data,
  };
}

async function runTool(name, args = {}) {
  switch (name) {
    case "search_contact":
      return searchContact(args.query);
    case "create_contact":
      return createContact(args.contact);
    case "update_contact":
      return updateContact(args.id, args.contact);
    case "edit_contact":
      return updateContact(args.id, args.contact);
    case "create_note":
      return createNote(args.note);
    case "create_deal":
      return createDeal(args.deal);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function getTools() {
  return [
    {
      name: "search_contact",
      description: "Search a contact in Freshsales by name, email, or text query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text." },
        },
        required: ["query"],
      },
    },
    {
      name: "create_contact",
      description: "Create a contact in Freshsales.",
      inputSchema: {
        type: "object",
        properties: {
          contact: {
            type: "object",
            description: "Contact payload sent to Freshsales /contacts.",
            properties: {
              first_name: { type: "string" },
              last_name: { type: "string" },
              email: { type: "string" },
              mobile_number: { type: "string" },
              work_number: { type: "string" },
              city: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["contact"],
      },
    },
    {
      name: "update_contact",
      description: "Update an existing contact by Freshsales contact ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Freshsales contact ID." },
          contact: {
            type: "object",
            description: "Partial contact payload with fields to update.",
            properties: {
              first_name: { type: "string" },
              last_name: { type: "string" },
              email: { type: "string" },
              mobile_number: { type: "string" },
              work_number: { type: "string" },
              city: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["id", "contact"],
      },
    },
    {
      name: "edit_contact",
      description: "Edit an existing contact by Freshsales contact ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Freshsales contact ID." },
          contact: {
            type: "object",
            description: "Partial contact payload with fields to update.",
            properties: {
              first_name: { type: "string" },
              last_name: { type: "string" },
              email: { type: "string" },
              mobile_number: { type: "string" },
              work_number: { type: "string" },
              city: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["id", "contact"],
      },
    },
    {
      name: "create_note",
      description: "Create a note in Freshsales.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "object",
            description: "Note payload sent to Freshsales /notes.",
            properties: {
              description: { type: "string" },
              targetable_type: { type: "string" },
              targetable_id: { type: "number" },
            },
            required: ["description", "targetable_type", "targetable_id"],
            additionalProperties: true,
          },
        },
        required: ["note"],
      },
    },
    {
      name: "create_deal",
      description: "Create a deal in Freshsales.",
      inputSchema: {
        type: "object",
        properties: {
          deal: {
            type: "object",
            description: "Deal payload sent to Freshsales /deals.",
            properties: {
              name: { type: "string" },
              amount: { type: "number" },
              expected_close: { type: "string" },
              contact_id: { type: "number" },
              stage_id: { type: "number" },
            },
            additionalProperties: true,
          },
        },
        required: ["deal"],
      },
    },
  ];
}

async function main() {
  const server = new Server(
    {
      name: "freshsales-basic-mcp",
      version: "2.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      const result = await runTool(name, args);
      return toToolResult(result);
    } catch (error) {
      const message = error.response?.data ?? error.message;
      return toToolResult({ success: false, error: message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Freshsales Basic MCP Server (v2.1.0) running...");
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
