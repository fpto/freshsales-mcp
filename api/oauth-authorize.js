import { createAuthCode, setCorsHeaders } from "./oauth-utils.js";

export default function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const {
    response_type,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query;

  if (response_type !== "code") {
    return res.status(400).json({ error: "unsupported_response_type" });
  }

  if (!client_id || !redirect_uri || !code_challenge) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const code = createAuthCode({
    client_id,
    code_challenge,
    code_challenge_method: code_challenge_method || "S256",
    redirect_uri,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(302, redirectUrl.toString());
}
