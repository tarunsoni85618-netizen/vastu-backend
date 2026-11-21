import { jwtVerify } from "jose";

export function extractToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (authHeader) {
    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).replace(/^"(.*)"$/, "$1").trim();
    }
    return authHeader.replace(/^"(.*)"$/, "$1").trim();
  }
  if (req.cookies?.vastu_session) {
    return String(req.cookies.vastu_session).replace(/^"(.*)"$/, "$1").trim();
  }
  return null;
}

export async function verifyToken(token) {
  if (!token || !process.env.AUTH_SECRET) return null;
  try {
    const clean = String(token).replace(/^"(.*)"$/, "$1").trim();
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
    const { payload } = await jwtVerify(clean, secret);
    return payload;
  } catch (err) {
    return null;
  }
}

export async function requireAdmin(req, res, next) {
  const token = extractToken(req);

  if (!token || !process.env.AUTH_SECRET) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  try {
    const payload = await verifyToken(token);
    if (!payload) {
      return res.status(401).json({ success: false, error: "Invalid or expired session" });
    }
    if (payload.role !== "admin") {
      return res.status(403).json({ success: false, error: "Administrator access required" });
    }

    req.user = {
      ...payload,
      id: payload.sub,
      _id: payload.sub,
    };
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired session" });
  }
}

export async function requireUser(req, res, next) {
  const token = extractToken(req);

  if (!token || !process.env.AUTH_SECRET) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  try {
    const payload = await verifyToken(token);
    if (!payload || !payload.sub) {
      return res.status(401).json({ success: false, error: "Invalid or expired session" });
    }

    req.user = {
      ...payload,
      id: payload.sub,
      _id: payload.sub,
    };
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired session" });
  }
}

export function authError(auth, res) {
  return res.status(auth.status).json({ success: false, error: auth.error });
}

export async function optionalUser(req, res, next) {
  const token = extractToken(req);

  if (token && process.env.AUTH_SECRET) {
    try {
      const payload = await verifyToken(token);
      if (payload && payload.sub) {
        req.user = {
          ...payload,
          id: payload.sub,
          _id: payload.sub,
        };
      }
    } catch {}
  }
  next();
}
