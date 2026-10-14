// Acceso al panel: passkey / Face ID (WebAuthn hecho a mano, sin dependencias) y, si no hay passkey a mano,
// un enlace de un solo uso que manda el bot de Telegram (/acceso).
//
//   GET  /auth/status              → { authed, hasCredentials }
//   POST /auth/login/options       → challenge para navigator.credentials.get
//   POST /auth/login               → verifica la firma y abre sesión
//   POST /auth/recover             → canjea el enlace de /acceso y abre sesión
//   POST /auth/register/options    → challenge para navigator.credentials.create (sesión de <10 min)
//   POST /auth/register            → guarda la passkey nueva
//   GET  /auth/credentials         → passkeys guardadas · DELETE /auth/credentials/:id
//   POST /auth/logout
//
// La sesión es una cookie HttpOnly con 32 bytes aleatorios; en D1 solo está su SHA-256.
// El navegador entra con la cookie; la app de Mac sigue entrando con `Bearer DASH_TOKEN`.

import config from "../config.js";

const COOKIE = "__Host-tb";
const SESSION_DAYS = 30;
const FRESH_MIN = 10; // registrar una passkey solo con una sesión recién abierta
const CHALLENGE_MIN = 5;
const RECOVERY_MIN = 10;
const MAX_ATTEMPTS = 20; // por IP y ventana de 10 min
const ES256 = -7;
const RS256 = -257;

// Origen del panel. En local (`wrangler dev`) se cambia con PANEL_ORIGIN en .dev.vars.
export const panelOrigin = (env) => env.PANEL_ORIGIN || config.panel.origin;
const rpId = (env) => new URL(panelOrigin(env)).hostname;

// ---------- utilidades ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
const sha256hex = async (data) => [...await sha256(data)].map((b) => b.toString(16).padStart(2, "0")).join("");
const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

// CBOR mínimo (RFC 8949): lo justo para attestationObject y claves COSE. Devuelve [valor, siguiente offset].
export function cbor(buf, pos = 0) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const head = buf[pos++];
  const major = head >> 5;
  let n = head & 31;
  if (n === 24) n = buf[pos++];
  else if (n === 25) { n = view.getUint16(pos); pos += 2; }
  else if (n === 26) { n = view.getUint32(pos); pos += 4; }
  else if (n === 27) { n = Number(view.getBigUint64(pos)); pos += 8; }
  else if (n > 27) throw new Error("cbor: longitud indefinida no soportada");
  switch (major) {
    case 0: return [n, pos];
    case 1: return [-1 - n, pos];
    case 2: return [buf.slice(pos, pos + n), pos + n];
    case 3: return [dec.decode(buf.subarray(pos, pos + n)), pos + n];
    case 4: {
      const out = [];
      for (let i = 0; i < n; i++) { let v; [v, pos] = cbor(buf, pos); out.push(v); }
      return [out, pos];
    }
    case 5: {
      const out = new Map();
      for (let i = 0; i < n; i++) {
        let k, v;
        [k, pos] = cbor(buf, pos);
        [v, pos] = cbor(buf, pos);
        out.set(k, v);
      }
      return [out, pos];
    }
    case 7: return [n === 20 ? false : n === 21 ? true : null, pos];
    default: throw new Error(`cbor: tipo ${major} no soportado`);
  }
}

// Clave COSE → JWK + algoritmo.
export function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === ES256 && cose.get(-1) === 1) {
    return { alg, jwk: { kty: "EC", crv: "P-256", x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  }
  if (kty === 3 && alg === RS256) {
    return { alg, jwk: { kty: "RSA", n: b64url(cose.get(-1)), e: b64url(cose.get(-2)), alg: "RS256" } };
  }
  throw new Error(`clave no soportada (kty ${kty}, alg ${alg})`);
}

// Firma ECDSA en DER (lo que devuelve WebAuthn) → r‖s de 32 + 32 bytes (lo que espera WebCrypto).
export function derToRaw(der) {
  if (der[0] !== 0x30) throw new Error("firma no DER");
  let pos = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const out = new Uint8Array(64);
  for (const at of [0, 32]) {
    if (der[pos++] !== 0x02) throw new Error("firma no DER");
    const len = der[pos++];
    let int = der.subarray(pos, pos + len);
    pos += len;
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    if (int.length > 32) throw new Error("firma no DER");
    out.set(int, at + 32 - int.length);
  }
  return out;
}

function importKey(alg, jwk) {
  return alg === ES256
    ? crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    : crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

// authenticatorData: rpIdHash(32) · flags(1) · signCount(4) · [aaguid(16) · credIdLen(2) · credId · clave COSE]
async function parseAuthData(env, authData, withCredential) {
  if (!equalBytes(authData.subarray(0, 32), await sha256(rpId(env)))) throw new Error("rpId distinto");
  const flags = authData[32];
  if (!(flags & 0x01)) throw new Error("sin presencia del usuario");
  if (!(flags & 0x04)) throw new Error("sin Face ID / huella");
  const signCount = new DataView(authData.buffer, authData.byteOffset).getUint32(33);
  if (!withCredential) return { signCount };
  if (!(flags & 0x40)) throw new Error("falta la credencial");
  const idLen = (authData[53] << 8) | authData[54];
  const credId = authData.slice(55, 55 + idLen);
  const [cose] = cbor(authData, 55 + idLen);
  return { signCount, credId, cose };
}

// ---------- challenges y enlaces de un solo uso ----------
async function issueToken(env, kind, minutes) {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO auth_tokens (hash, kind, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(await sha256hex(token), kind, `+${minutes} minutes`).run();
  return token;
}

// Lo marca como usado en la misma sentencia: dos peticiones a la vez no pueden canjearlo las dos.
async function consumeToken(env, kind, token) {
  if (!token) return false;
  const r = await env.DB.prepare(
    `UPDATE auth_tokens SET used_at=datetime('now')
     WHERE hash=? AND kind=? AND used_at IS NULL AND expires_at > datetime('now')`
  ).bind(await sha256hex(token), kind).run();
  return r.meta.changes === 1;
}

/** Enlace de recuperación de un solo uso (lo manda /acceso por Telegram). El token va en el fragmento: no llega a ningún log. */
export async function createRecoveryLink(env) {
  return `${panelOrigin(env)}/recuperar#${await issueToken(env, "recovery", RECOVERY_MIN)}`;
}

function checkClientData(env, raw, type) {
  const c = JSON.parse(dec.decode(raw));
  if (c.type !== type) throw new Error("tipo de operación incorrecto");
  if (c.origin !== panelOrigin(env)) throw new Error("origen incorrecto");
  return c;
}

// ---------- sesiones ----------
function readCookie(request) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

async function session(env, request) {
  const value = readCookie(request);
  if (!value) return null;
  return env.DB.prepare(
    `SELECT token_hash, (created_at > datetime('now', ?)) AS fresh FROM sessions WHERE token_hash=? AND expires_at > datetime('now')`
  ).bind(`-${FRESH_MIN} minutes`, await sha256hex(value)).first();
}

async function openSession(env, request, body) {
  const value = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, expires_at, user_agent) VALUES (?, datetime('now', ?), ?)`)
    .bind(await sha256hex(value), `+${SESSION_DAYS} days`, (request.headers.get("user-agent") || "").slice(0, 200)).run();
  return json(body, 200, {
    "set-cookie": `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

const sameOrigin = (env, request) => request.headers.get("origin") === panelOrigin(env);

/**
 * ¿Quién llama? "token" (Bearer DASH_TOKEN: app de Mac, scripts) o "session" (cookie del panel).
 * Con cookie, todo lo que no sea GET tiene que venir del propio panel (CSRF).
 */
export async function requireAuth(request, env) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (env.DASH_TOKEN && bearer === env.DASH_TOKEN) return "token";
  const s = await session(env, request);
  if (!s) return null;
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(env, request)) return null;
  return "session";
}

// Límite de intentos por IP (hash) en ventanas de 10 min, en D1 para no gastar escrituras de KV.
async function overLimit(env, request) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const key = await sha256hex(`${ip}:${Math.floor(Date.now() / 600000)}`);
  const row = await env.DB.prepare(
    `INSERT INTO auth_attempts (key, count, expires_at) VALUES (?, 1, datetime('now', '+10 minutes'))
     ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`
  ).bind(key).first();
  return row.count > MAX_ATTEMPTS;
}

/** Limpieza diaria: sesiones, challenges, enlaces y contadores caducados. */
export async function purgeAuth(env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
    env.DB.prepare(`DELETE FROM auth_tokens WHERE expires_at <= datetime('now', '-1 day')`),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE expires_at <= datetime('now')`),
  ]);
}

// ---------- rutas ----------
export async function handleAuth(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice("/auth/".length);
  const method = request.method;

  try {
    if (method === "GET" && path === "status") {
      const [s, n] = await Promise.all([
        session(env, request),
        env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first(),
      ]);
      return json({ authed: !!s, fresh: !!s?.fresh, hasCredentials: n.n > 0 });
    }

    if (method !== "GET") {
      if (!sameOrigin(env, request)) return json({ error: "forbidden" }, 403);
      if (await overLimit(env, request)) return json({ error: "demasiados intentos, espera unos minutos" }, 429);
    }

    if (method === "POST" && path === "login/options") {
      return json({
        challenge: await issueToken(env, "challenge:login", CHALLENGE_MIN),
        rpId: rpId(env),
        userVerification: "required",
        timeout: CHALLENGE_MIN * 60000,
      });
    }

    if (method === "POST" && path === "login") {
      const body = await request.json();
      const r = body.response || {};
      const clientDataJSON = fromB64url(r.clientDataJSON);
      const c = checkClientData(env, clientDataJSON, "webauthn.get");
      if (!await consumeToken(env, "challenge:login", c.challenge)) return json({ error: "challenge caducado" }, 400);

      const cred = await env.DB.prepare("SELECT * FROM credentials WHERE id=?").bind(body.id).first();
      if (!cred) return json({ error: "passkey desconocida" }, 401);

      const authData = fromB64url(r.authenticatorData);
      const { signCount } = await parseAuthData(env, authData, false);
      const signed = new Uint8Array(authData.length + 32);
      signed.set(authData);
      signed.set(await sha256(clientDataJSON), authData.length);

      const key = await importKey(cred.alg, JSON.parse(cred.public_key));
      const sig = fromB64url(r.signature);
      const ok = cred.alg === ES256
        ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), signed)
        : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
      if (!ok) return json({ error: "firma no válida" }, 401);

      // Las passkeys sincronizadas (iCloud) dejan el contador a 0: solo se comprueba si alguno lo usa.
      if ((signCount || cred.sign_count) && signCount <= cred.sign_count) return json({ error: "passkey clonada" }, 401);
      await env.DB.prepare("UPDATE credentials SET sign_count=?, last_used_at=datetime('now') WHERE id=?")
        .bind(signCount, cred.id).run();
      return openSession(env, request, { ok: true });
    }

    if (method === "POST" && path === "recover") {
      const { token } = await request.json();
      if (!await consumeToken(env, "recovery", token)) return json({ error: "enlace caducado o ya usado: pide otro con /acceso" }, 401);
      return openSession(env, request, { ok: true, fresh: true });
    }

    // A partir de aquí, con sesión.
    const s = await session(env, request);
    if (!s) return json({ error: "unauthorized" }, 401);

    if (method === "POST" && path === "register/options") {
      if (!s.fresh) return json({ error: "vuelve a entrar para añadir una passkey" }, 403);
      const { results } = await env.DB.prepare("SELECT id FROM credentials").all();
      return json({
        challenge: await issueToken(env, "challenge:register", CHALLENGE_MIN),
        rp: { id: rpId(env), name: "taskbot" },
        user: { id: b64url(enc.encode("taskbot-owner")), name: "taskbot", displayName: "taskbot" },
        pubKeyCredParams: [{ type: "public-key", alg: ES256 }, { type: "public-key", alg: RS256 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        excludeCredentials: results.map((x) => ({ type: "public-key", id: x.id })),
        timeout: CHALLENGE_MIN * 60000,
      });
    }

    if (method === "POST" && path === "register") {
      if (!s.fresh) return json({ error: "vuelve a entrar para añadir una passkey" }, 403);
      const body = await request.json();
      const r = body.response || {};
      const c = checkClientData(env, fromB64url(r.clientDataJSON), "webauthn.create");
      if (!await consumeToken(env, "challenge:register", c.challenge)) return json({ error: "challenge caducado" }, 400);

      const [att] = cbor(fromB64url(r.attestationObject));
      const { signCount, credId, cose } = await parseAuthData(env, att.get("authData"), true);
      const { alg, jwk } = coseToJwk(cose);
      await importKey(alg, jwk); // que se pueda usar antes de guardarla
      const name = String(body.name || "").trim().slice(0, 60) || "Passkey";
      await env.DB.prepare("INSERT INTO credentials (id, public_key, alg, sign_count, name) VALUES (?, ?, ?, ?, ?)")
        .bind(b64url(credId), JSON.stringify(jwk), alg, signCount, name).run();
      return json({ ok: true });
    }

    if (method === "GET" && path === "credentials") {
      const { results } = await env.DB.prepare(
        "SELECT id, name, created_at, last_used_at FROM credentials ORDER BY created_at"
      ).all();
      return json({ credentials: results });
    }

    if (method === "DELETE" && path.startsWith("credentials/")) {
      await env.DB.prepare("DELETE FROM credentials WHERE id=?").bind(decodeURIComponent(path.slice(12))).run();
      return json({ ok: true });
    }

    if (method === "POST" && path === "logout") {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(s.token_hash).run();
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
  } catch (e) {
    console.error("auth", path, e?.message || e);
    return json({ error: String(e?.message || e) }, 400);
  }
  return json({ error: "not found" }, 404);
}
