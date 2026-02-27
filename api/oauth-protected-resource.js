import { setCorsHeaders } from "./oauth-utils.js";

export default function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const host = `https://${req.headers.host}`;

  res.json({
    resource: host,
    authorization_servers: [host],
    bearer_methods_supported: ["header"],
  });
}
