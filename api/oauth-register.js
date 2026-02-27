import crypto from "crypto";
import { setCorsHeaders } from "./oauth-utils.js";

export default function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { client_name, redirect_uris, grant_types, response_types } = req.body;

  res.status(201).json({
    client_id: crypto.randomUUID(),
    client_name: client_name || "MCP Client",
    redirect_uris: redirect_uris || [],
    grant_types: grant_types || ["authorization_code"],
    response_types: response_types || ["code"],
    token_endpoint_auth_method: "none",
  });
}
