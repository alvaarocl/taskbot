// Saca el token de la app móvil de Moodle y lo guarda como secreto AULAGLOBAL_TOKEN del worker.
// Sin dependencias. El token nunca se imprime.
//
//   node scripts/moodle-token.mjs https://tu-moodle.edu
//
// - Moodle con usuario y contraseña: te los pide y usa /login/token.php.
// - Moodle con inicio de sesión de la universidad (SSO, como Aula Global en la UC3M): te da un enlace;
//   ábrelo en el navegador con la sesión ya iniciada. Te redirige a una dirección moodlemobile://token=…
//   que el navegador no sabe abrir: cópiala (barra de direcciones, o DevTools → Network → la petición
//   launch.php → cabecera Location) y pégala aquí.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const site = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\//.test(site)) {
  console.error("Uso: node scripts/moodle-token.mjs https://tu-moodle.edu");
  process.exit(1);
}
const rl = createInterface({ input: stdin, output: stdout });
const sso = /^s/i.test(await rl.question("¿Entras con usuario y contraseña de Moodle (u) o con el login de tu universidad (s)? [u/s] "));

let token;
if (!sso) {
  const username = await rl.question("Usuario: ");
  const password = await rl.question("Contraseña (se ve al escribir; no se guarda): ");
  const r = await fetch(`${site}/login/token.php`, {
    method: "POST",
    body: new URLSearchParams({ username, password, service: "moodle_mobile_app" }),
  });
  const j = await r.json();
  if (!j.token) {
    console.error(`Moodle no ha dado token: ${j.error || r.status}. Si tu Moodle usa el login de la universidad, repite con "s".`);
    process.exit(1);
  }
  token = j.token;
} else {
  const passport = randomBytes(8).toString("hex");
  console.log(`\n1. Inicia sesión en ${site} en tu navegador.\n2. Abre este enlace en esa misma ventana:\n\n   ${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile\n`);
  const pasted = await rl.question("3. Pega aquí la dirección moodlemobile://token=… : ");
  const m = /token=([A-Za-z0-9+/=]+)/.exec(pasted);
  const [signature, t] = m ? Buffer.from(m[1], "base64").toString().split(":::") : [];
  if (!m || signature !== createHash("md5").update(site + passport).digest("hex") || !/^[0-9a-f]{32}$/.test(t || "")) {
    console.error("Esa dirección no es la respuesta de este enlace (o ha caducado). Vuelve a empezar.");
    process.exit(1);
  }
  token = t;
}
rl.close();

// Comprobación antes de guardar: ¿quién soy?
const info = await (await fetch(`${site}/webservice/rest/server.php`, {
  method: "POST",
  body: new URLSearchParams({ wstoken: token, wsfunction: "core_webservice_get_site_info", moodlewsrestformat: "json" }),
})).json();
if (info.exception) {
  console.error(`El token no funciona: ${info.message}`);
  process.exit(1);
}
console.log(`Token válido para ${info.fullname} (${info.sitename}). Guardándolo en Cloudflare…`);
const put = spawnSync("npx", ["wrangler", "secret", "put", "AULAGLOBAL_TOKEN"], { input: token, stdio: ["pipe", "inherit", "inherit"] });
process.exit(put.status ?? 1);
