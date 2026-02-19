const STATIC_AUTH_CODE = "freshsales-static-auth-code";
const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;

const getBodyValue = (req, key) => {
  if (!req.body) return undefined;

  if (typeof req.body === "string") {
    const params = new URLSearchParams(req.body);
    return params.get(key) ?? undefined;
  }

  if (typeof req.body === "object") {
    return req.body[key];
  }

  return undefined;
};

export default async function handler(req, res) {
  if (!ACCESS_TOKEN) {
    return res.status(500).json({ error: "Missing required env var: MCP_ACCESS_TOKEN" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const grantType = getBodyValue(req, "grant_type");
  const code = getBodyValue(req, "code");

  if (grantType && grantType !== "authorization_code") {
    return res.status(400).json({ error: "Unsupported grant_type. Use authorization_code." });
  }

  if (code !== STATIC_AUTH_CODE) {
    return res.status(400).json({ error: "Invalid authorization code." });
  }

  return res.status(200).json({
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
  });
}
