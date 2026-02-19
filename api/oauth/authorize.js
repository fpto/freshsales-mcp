const STATIC_AUTH_CODE = "freshsales-static-auth-code";

const appendQueryParam = (url, key, value) => {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  const { redirect_uri: redirectUri, state } = req.query;

  if (!redirectUri || typeof redirectUri !== "string") {
    return res.status(400).json({ error: "Missing required query param: redirect_uri" });
  }

  let location = appendQueryParam(redirectUri, "code", STATIC_AUTH_CODE);
  if (state && typeof state === "string") {
    location = appendQueryParam(location, "state", state);
  }

  return res.redirect(302, location);
}
