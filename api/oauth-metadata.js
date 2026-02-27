import { setCorsHeaders } from "./oauth-utils.js";

export default function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const host = `https://${req.headers.host}`;

  res.json({
    issuer: host,
    authorization_endpoint: `${host}/oauth/authorize`,
    token_endpoint: `${host}/oauth/token`,
    registration_endpoint: `${host}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
