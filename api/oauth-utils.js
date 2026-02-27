import crypto from "crypto";

const SIGNING_KEY = crypto
  .createHash("sha256")
  .update(process.env.FRESHSALES_API_KEY || "mcp-oauth-default-key")
  .digest();

function sign(payload) {
  const data = JSON.stringify(payload);
  const hmac = crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(data)
    .digest("hex");
  return Buffer.from(JSON.stringify({ d: data, h: hmac })).toString(
    "base64url",
  );
}

function verify(token) {
  try {
    const { d: data, h: hmac } = JSON.parse(
      Buffer.from(token, "base64url").toString(),
    );
    const expected = crypto
      .createHmac("sha256", SIGNING_KEY)
      .update(data)
      .digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
      return null;
    }
    const payload = JSON.parse(data);
    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function createAuthCode({
  client_id,
  code_challenge,
  code_challenge_method,
  redirect_uri,
}) {
  return sign({
    t: "code",
    client_id,
    code_challenge,
    code_challenge_method,
    redirect_uri,
    exp: Date.now() + 5 * 60 * 1000,
  });
}

export function verifyAuthCode(code) {
  const payload = verify(code);
  return payload?.t === "code" ? payload : null;
}

export function createAccessToken({ client_id }) {
  return sign({
    t: "access",
    client_id,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
}

export function verifyAccessToken(token) {
  const payload = verify(token);
  return payload?.t === "access" ? payload : null;
}

export function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}
