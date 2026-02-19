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

async function searchEntity(entity, query) {
  const res = await http.get("/search", {
    params: { q: query, include: entity },
  });

  return {
    success: true,
    entity,
    query,
    results: res.data,
  };
}

async function createEntity(endpoint, wrapperKey, payload) {
  const res = await http.post(endpoint, { [wrapperKey]: payload });
  return {
    success: true,
    entity: wrapperKey,
    data: res.data[wrapperKey] ?? res.data,
  };
}

async function editEntity(endpoint, wrapperKey, id, payload) {
  const res = await http.put(`${endpoint}/${id}`, { [wrapperKey]: payload });
  return {
    success: true,
    entity: wrapperKey,
    id,
    data: res.data[wrapperKey] ?? res.data,
  };
}

async function runTool(name, args = {}) {
  switch (name) {
    case "search_contacts":
      return searchEntity("contact", args.query);
    case "create_contact":
      return createEntity("/contacts", "contact", args.contact);
    case "edit_contact":
      return editEntity("/contacts", "contact", args.id, args.contact);

    case "search_notes":
      return searchEntity("note", args.query);
    case "create_note":
      return createEntity("/notes", "note", args.note);
    case "edit_note":
      return editEntity("/notes", "note", args.id, args.note);

    case "search_deals":
      return searchEntity("deal", args.query);
    case "create_deal":
      return createEntity("/deals", "deal", args.deal);
    case "edit_deal":
      return editEntity("/deals", "deal", args.id, args.deal);

    case "search_appointments":
      return searchEntity("appointment", args.query);
    case "create_appointment":
      return createEntity("/appointments", "appointment", args.appointment);
    case "edit_appointment":
      return editEntity("/appointments", "appointment", args.id, args.appointment);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function getTools() {
  const contactSchema = {
    type: "object",
    properties: {
      first_name: { type: "string", description: "Contact first name." },
      last_name: { type: "string", description: "Contact last name." },
      email: { type: "string", description: "Primary email address." },
      mobile_number: { type: "string", description: "Mobile phone number." },
      work_number: { type: "string", description: "Work phone number." },
      city: { type: "string", description: "City." },
    },
    additionalProperties: true,
  };

  const noteSchema = {
    type: "object",
    properties: {
      description: { type: "string", description: "Note content." },
      targetable_type: {
        type: "string",
        description: "Entity type, usually 'Contact'.",
      },
      targetable_id: {
        type: "number",
        description: "ID of the related entity.",
      },
    },
    required: ["description", "targetable_type", "targetable_id"],
    additionalProperties: true,
  };

  const dealSchema = {
    type: "object",
    properties: {
      name: { type: "string", description: "Deal name." },
      amount: { type: "number", description: "Deal value." },
      expected_close: {
        type: "string",
        description: "Expected close date (YYYY-MM-DD).",
      },
      contact_id: { type: "number", description: "Primary contact ID." },
      stage_id: { type: "number", description: "Sales stage ID." },
    },
    additionalProperties: true,
  };

  const appointmentSchema = {
    type: "object",
    properties: {
      title: { type: "string", description: "Appointment title." },
      from_date: {
        type: "string",
        description: "Start datetime in ISO 8601 format.",
      },
      end_date: {
        type: "string",
        description: "End datetime in ISO 8601 format.",
      },
      owner_id: { type: "number", description: "Owner user ID." },
      contact_id: { type: "number", description: "Related contact ID." },
    },
    additionalProperties: true,
  };

  return [
    {
      name: "search_contacts",
      description: "Search contacts in Freshsales.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
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
            ...contactSchema,
            description: "Contact payload used by Freshsales contacts endpoint.",
          },
        },
        required: ["contact"],
      },
    },
    {
      name: "edit_contact",
      description: "Edit an existing contact by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Freshsales contact ID." },
          contact: {
            ...contactSchema,
            description: "Partial contact payload with fields to update.",
          },
        },
        required: ["id", "contact"],
      },
    },
    {
      name: "search_notes",
      description: "Search notes in Freshsales.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "create_note",
      description: "Create a note in Freshsales.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            ...noteSchema,
            description: "Note payload used by Freshsales notes endpoint.",
          },
        },
        required: ["note"],
      },
    },
    {
      name: "edit_note",
      description: "Edit an existing note by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Freshsales note ID." },
          note: {
            ...noteSchema,
            description: "Partial note payload with fields to update.",
          },
        },
        required: ["id", "note"],
      },
    },
    {
      name: "search_deals",
      description: "Search deals in Freshsales.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "create_deal",
      description: "Create a deal in Freshsales.",
      inputSchema: {
        type: "object",
        properties: {
          deal: {
            ...dealSchema,
            description: "Deal payload used by Freshsales deals endpoint.",
          },
        },
        required: ["deal"],
      },
    },
    {
      name: "edit_deal",
      description: "Edit an existing deal by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Freshsales deal ID." },
          deal: {
            ...dealSchema,
            description: "Partial deal payload with fields to update.",
          },
        },
        required: ["id", "deal"],
      },
    },
    {
      name: "search_appointments",
      description: "Search appointments in Freshsales.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "create_appointment",
      description: "Create an appointment in Freshsales.",
      inputSchema: {
        type: "object",
        properties: {
          appointment: {
            ...appointmentSchema,
            description:
              "Appointment payload used by Freshsales appointments endpoint.",
          },
        },
        required: ["appointment"],
      },
    },
    {
      name: "edit_appointment",
      description: "Edit an existing appointment by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Freshsales appointment ID." },
          appointment: {
            ...appointmentSchema,
            description: "Partial appointment payload with fields to update.",
          },
        },
        required: ["id", "appointment"],
      },
    },
  ];
}

async function main() {
  const server = new Server(
    {
      name: "freshsales-basic-mcp",
      version: "2.0.0",
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
  console.error("Freshsales Basic MCP Server (v2.0.0) running...");
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
