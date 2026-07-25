/**
 * Session cookie helpers (`plancel_session`, httpOnly, SameSite=Lax;
 * `Secure` only over https so local http dev still works).
 */
export const SESSION_COOKIE = "plancel_session";

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

export function sessionSetCookie(sid: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` +
    (secure ? "; Secure" : "");
}

export function sessionClearCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secure ? "; Secure" : "");
}
