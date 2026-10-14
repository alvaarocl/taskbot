// Passkeys en el navegador: navigator.credentials con los challenges de /auth/*. Sin dependencias.

const toB64url = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (str) => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function post(path, body = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  return j;
}

export const supported = () => !!window.PublicKeyCredential && !!navigator.credentials;

// Mensajes de error de WebAuthn en cristiano.
export function explain(e) {
  if (e?.name === "NotAllowedError") return "Cancelado o sin respuesta. Vuelve a intentarlo.";
  if (e?.name === "InvalidStateError") return "Este dispositivo ya tiene una passkey de taskbot.";
  if (e?.name === "SecurityError") return "Las passkeys solo funcionan en el dominio del panel.";
  return e?.message || String(e);
}

export async function login() {
  const o = await post("/auth/login/options");
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: fromB64url(o.challenge),
      rpId: o.rpId,
      userVerification: o.userVerification,
      timeout: o.timeout,
    },
  });
  const r = cred.response;
  return post("/auth/login", {
    id: cred.id,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
    },
  });
}

export async function register(name) {
  const o = await post("/auth/register/options");
  const cred = await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64url(o.challenge),
      user: { ...o.user, id: fromB64url(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: fromB64url(c.id) })),
    },
  });
  return post("/auth/register", {
    name,
    response: {
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      attestationObject: toB64url(cred.response.attestationObject),
    },
  });
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}
