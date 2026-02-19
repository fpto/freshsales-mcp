import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const API_KEY = process.env.FRESHSALES_API_KEY;
const BASE_URL = (process.env.FRESHSALES_BASE_URL || "").replace(/\/$/, "");

const http = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Token token=${API_KEY}`,
    "Content-Type": "application/json",
  },
});

async function findContactId(query) {
  try {
    const res = await http.get("/search", {
      params: { q: query, include: "contact" },
    });

    const results = res.data || [];
    const match = results.find(
      (item) => item.type === "contact" || item.entity_type === "contact",
    );
    return match ? match.id || match.entity_id : null;
  } catch (err) {
    console.error("Error en búsqueda:", err.message);
    return null;
  }
}

const cleanText = (text) => text || "No especificado";

async function getClientBrief(query) {
  try {
    const contactId = await findContactId(query);
    if (!contactId) return `No se encontró al cliente: "${query}"`;

    const detailRes = await http.get(`/contacts/${contactId}`);
    const c = detailRes.data.contact;
    const cf = c.custom_field || {};

    let recentNotes = [];
    try {
      const notesRes = await http.get(`/contacts/${contactId}/notes`, {
        params: { sort: "created_at", sort_type: "desc", per_page: 3 },
      });
      recentNotes = notesRes.data?.notes || [];
    } catch {
      // ignorar error de notas
    }

    return {
      type: "CLIENT_BRIEF",
      cliente: {
        nombre: c.display_name,
        email: c.email,
        celular: c.mobile_number,
        telefono_trabajo: c.work_number,
        ubicacion: c.city || c.address,
      },
      perfil_facebook: {
        presupuesto: cleanText(cf.cf_techo_de_presupuesto_fb),
        zona_interes: cleanText(cf.cf_zonas_de_interes),
        tiempo_decision: cleanText(cf.cf_tiempo_decision),
        precalificado: cleanText(cf.cf_precalificado_fb),
      },
      historial_reciente: recentNotes.map((n) => ({
        fecha: new Date(n.created_at).toLocaleDateString(),
        nota: n.description,
      })),
    };
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function createContact(params) {
  const { name, email, phone, city } = params;

  let first_name = "";
  let last_name = name;
  if (name && name.includes(" ")) {
    const parts = name.trim().split(" ");
    if (parts.length > 1) {
      last_name = parts.pop();
      first_name = parts.join(" ");
    }
  }

  const payload = {
    contact: {
      first_name,
      last_name,
      email,
      mobile_number: phone,
      city,
    },
  };

  try {
    const res = await http.post("/contacts", payload);
    const newContact = res.data.contact;
    return {
      success: true,
      message: `Contacto creado: ${newContact.display_name} (ID: ${newContact.id})`,
    };
  } catch (err) {
    if (err.response?.status === 409)
      return "Error: Ya existe un contacto con ese dato.";
    return `Error creando: ${err.message}`;
  }
}

async function modifyContactDetails(params) {
  const { query, phone, work_phone, email, city } = params;

  try {
    const contactId = await findContactId(query);
    if (!contactId) return `No se encontró al contacto: "${query}"`;

    const contactPayload = {};

    if (email) contactPayload.email = email;
    if (phone) contactPayload.mobile_number = phone;
    if (work_phone) contactPayload.work_number = work_phone;
    if (city) contactPayload.city = city;

    if (Object.keys(contactPayload).length === 0) {
      return "No enviaste datos para modificar.";
    }

    const payload = { contact: contactPayload };
    const res = await http.put(`/contacts/${contactId}`, payload);
    const updated = res.data.contact;

    return {
      success: true,
      message: "✅ Contacto modificado exitosamente.",
      datos_nuevos: {
        nombre: updated.display_name,
        nuevo_celular: updated.mobile_number,
        nuevo_trabajo: updated.work_number,
      },
    };
  } catch (err) {
    if (err.response?.status === 409)
      return "Error: El número ya pertenece a otro contacto (Campo Único).";
    return `Error actualizando: ${err.message}`;
  }
}

async function addNote(params) {
  const { query, content } = params;
  try {
    const contactId = await findContactId(query);
    if (!contactId) return `No encontré al cliente: "${query}"`;

    await http.post("/notes", {
      note: {
        description: content,
        targetable_type: "Contact",
        targetable_id: contactId,
      },
    });
    return { success: true, message: "Nota agregada." };
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function createMcpServer() {
  const server = new Server(
    {
      name: "freshsales-real-estate",
      version: "1.6.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_client_brief",
        description: "Obtiene la ficha del cliente.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "create_contact",
        description: "Crea un NUEVO contacto.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            city: { type: "string" },
          },
          required: ["name"],
        },
      },
      {
        name: "modify_contact_details",
        description:
          "AUTORIZADO: Modifica directamente la ficha del contacto. Úsalo para AGREGAR o CAMBIAR el teléfono, email o ciudad. Es la única forma de guardar números de teléfono.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Nombre o Email del contacto",
            },
            phone: {
              type: "string",
              description: "Campo 'mobile_number' (Celular)",
            },
            work_phone: {
              type: "string",
              description: "Campo 'work_number' (Trabajo)",
            },
            email: { type: "string" },
            city: { type: "string" },
          },
          required: ["query"],
        },
      },
      {
        name: "add_note",
        description:
          "Agrega una nota de texto al historial del cliente. Úsalo para registrar visitas, llamadas o cualquier interacción.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Nombre o Email del cliente",
            },
            content: {
              type: "string",
              description: "El contenido exacto de la nota",
            },
          },
          required: ["query", "content"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "get_client_brief":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await getClientBrief(args.query), null, 2),
            },
          ],
        };
      case "create_contact":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await createContact(args), null, 2),
            },
          ],
        };
      case "modify_contact_details":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await modifyContactDetails(args), null, 2),
            },
          ],
        };
      case "add_note":
        return {
          content: [
            { type: "text", text: JSON.stringify(await addNote(args), null, 2) },
          ],
        };
      default:
        throw new Error(`Herramienta desconocida: ${name}`);
    }
  });

  return server;
}

export default async function handler(req, res) {
  if (!API_KEY || !BASE_URL) {
    return res.status(500).json({
      error:
        "Faltan variables de entorno FRESHSALES_API_KEY y/o FRESHSALES_BASE_URL",
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
