import crypto from "crypto";
import { createAccessToken, setCorsHeaders, verifyAuthCode } from "./oauth-utils.js";

export default function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { grant_type, code, redirect_uri, client_id, code_verifier } =
    req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  if (!code || !code_verifier || !client_id) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const payload = verifyAuthCode(code);
  if (!payload) {
    return res.status(400).json({ error: "invalid_grant" });
  }

  // Verify PKCE: SHA-256(code_verifier) must match code_challenge
  const computed = crypto
    .createHash("sha256")
    .update(code_verifier)
    .digest("base64url");

  if (computed !== payload.code_challenge) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Code verifier mismatch",
    });
  }

  const access_token = createAccessToken({ client_id });

  res.json({
    access_token,
    token_type: "Bearer",
    expires_in: 604800,
  });
}
