# Montar tu propio taskbot (tuyo, aislado, 0 €)

Esto monta una instancia 100 % tuya: tu bot de Telegram, tu base de datos y tu panel, en la capa gratuita de
Cloudflare. No comparte nada con ninguna otra copia de este código.

> **Si eres Claude Code y te han pedido "monta taskbot" o "sigue DEPLOY.md":** haz los pasos en orden. Los
> marcados con ⏸ necesitan que la persona haga algo fuera de la terminal (hablar con un bot, aprobar algo en el
> navegador, darte un dato): para ahí, pídelo y no sigas hasta tenerlo. Nunca imprimas ni guardes en archivos
> del repo los tokens: van con `npx wrangler secret put`.

## Antes de empezar

1. Node.js LTS ([nodejs.org](https://nodejs.org)).
2. Cuenta gratis de Cloudflare (no pide tarjeta): https://dash.cloudflare.com/sign-up
3. Telegram en el móvil o el ordenador.

## Pasos

### 1. Archivos personales
```bash
cp config.example.js config.js
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars   # solo para probar en local
```
Ninguno de los tres se sube a git.

### 2. Bot de Telegram
⏸ En Telegram: habla con **@BotFather** → `/newbot` → nombre (p. ej. "Mi asistente") y un usuario acabado en
`bot`. BotFather devuelve un **token** (`123456789:AA…`).

### 3. Cloudflare
```bash
npx wrangler login
```
⏸ Se abre el navegador: autoriza.

Si tu cuenta tiene varias organizaciones, añade `account_id = "…"` en `wrangler.toml` (lo enseña
`npx wrangler whoami`).

### 4. Base de datos y almacén
```bash
npx wrangler d1 create taskbot
npx wrangler kv namespace create FILES
```
Copia el `database_id` y el `id` que imprimen en `wrangler.toml` (donde pone `RELLENAR`). Luego:
```bash
npx wrangler d1 execute taskbot --remote --file=schema.sql
```

### 5. Secretos obligatorios
```bash
npx wrangler secret put TELEGRAM_TOKEN      # el del paso 2
npx wrangler secret put TG_WEBHOOK_SECRET   # una cadena aleatoria que inventas
npx wrangler secret put DASH_TOKEN          # otra (clave de la app de Mac y scripts)
npx wrangler secret put CAL_TOKEN           # otra distinta (feeds de calendario)
```
Para generar cadenas: `node -e "console.log(crypto.randomUUID())"`.

### 6. Tu configuración
⏸ Pide a la persona lo necesario y rellena `config.js`. Cada bloque es un módulo; los opcionales se quitan
poniéndolos a `null`.

- `assistant`: su nombre, a qué se dedica (una frase), sus categorías y el lunes de la semana 1 del curso.
- `routine`: su semana fija (entrenos, trabajo…), festivos y vacaciones.
- `prefs`: entre qué horas se le pueden colocar tareas, comida, desplazamientos.
- `calendar.uidDomain`: el dominio `workers.dev` de su worker (`taskbot.<subdominio>.workers.dev`; el
  subdominio sale en `npx wrangler whoami` o en el primer deploy). No se cambia nunca después.
- `panel.origin`: dónde abrirá el panel. Sin dominio propio, el mismo `https://taskbot.<subdominio>.workers.dev`.
  Es el dominio de las passkeys: tampoco conviene cambiarlo.
- Opcionales: `uc3m` (solo estudiantes de la UC3M), `aulaGlobal` (cualquier Moodle: URL del sitio y nombre),
  `weekly` (usuario de GitHub y organizaciones), `social` (asistente de X; su voz en una frase).

**Dominio propio para el panel (opcional):** si el dominio ya está en la misma cuenta de Cloudflare, descomenta
`routes` en `wrangler.toml` con, p. ej., `panel.tudominio.com` y pon ese mismo origen en `panel.origin`. Los feeds,
el webhook y la API con token siguen en `workers.dev`; lo demás redirige al panel.

### 7. Desplegar
```bash
npx wrangler deploy
```
Imprime la URL `https://taskbot.<subdominio>.workers.dev`. Si no coincide con `calendar.uidDomain` o
`panel.origin`, corrígelos en `config.js` y vuelve a desplegar.

### 8. Conectar Telegram
Sustituye TOKEN, URL y SECRETO:
```bash
curl "https://api.telegram.org/botTOKEN/setWebhook?url=https://taskbot.<subdominio>.workers.dev/webhook&secret_token=SECRETO"
```
Debe responder `{"ok":true,...}`.

⏸ La persona escribe cualquier cosa al bot: le contesta con su **chat id**.
```bash
npx wrangler secret put OWNER_CHAT_ID
```
⏸ Que le vuelva a escribir `/start`: ahora sale el menú de comandos y ya funciona.

### 9. Entrar al panel
⏸ En Telegram, `/acceso`: llega un enlace de un solo uso (10 min). Al abrirlo, el panel ofrece crear una passkey
(Face ID / huella). En el iPhone, después: Compartir → Añadir a pantalla de inicio.

### 10. Calendario en el móvil (opcional)
En el iPhone: Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Añadir calendario suscrito. Una URL por
calendario (sustituye `CAL_TOKEN` y el dominio):
```
https://taskbot.<subdominio>.workers.dev/calendar.ics?t=CAL_TOKEN      tareas y eventos
https://taskbot.<subdominio>.workers.dev/cal/rutina.ics?t=CAL_TOKEN    rutina
https://taskbot.<subdominio>.workers.dev/cal/clases.ics?t=CAL_TOKEN    clases (módulo uc3m)
https://taskbot.<subdominio>.workers.dev/cal/practicas.ics?t=CAL_TOKEN prácticas y entregas
https://taskbot.<subdominio>.workers.dev/cal/examenes.ics?t=CAL_TOKEN  exámenes
https://taskbot.<subdominio>.workers.dev/cal/notion.ics?t=CAL_TOKEN    eventos de tu Notion (módulo notion)
```
En Google Calendar: "Otros calendarios → Desde URL", con las mismas direcciones.

## Módulos opcionales

### Moodle (entregas, avisos, notas y "¿qué toca mañana en X?")
Con `aulaGlobal.site` ya en `config.js`:
```bash
node scripts/moodle-token.mjs https://tu-moodle.edu
```
⏸ Pregunta si entra con usuario y contraseña de Moodle o con el login de la universidad (SSO) y sigue sus
instrucciones. Comprueba el token y lo guarda como secreto `AULAGLOBAL_TOKEN` sin imprimirlo. Cuando caduque, el
bot avisa por Telegram: se repite este paso.

### Notion (eventos, tareas y búsqueda)
Pon el bloque `notion` en `config.js` con los nombres de tus bases y campos (plantilla en `config.example.js`). El
token, según lo que te deje tu espacio de trabajo:
- **Token personal** (notion.so/developers/tokens → New token, capacidad "Notion API", caducidad 1 año): lee lo
  mismo que tú. Si no puedes crearlo, es que en ese espacio solo pueden los administradores.
- **Conexión interna** (la crea un administrador, con permiso solo de "Leer contenido"): hay que añadirla a las
  páginas raíz (••• → Conexiones) para que vea lo que cuelga de ellas.
```bash
pbpaste | npx wrangler secret put NOTION_TOKEN   # con el token copiado: no se escribe ni se imprime
```
Los eventos salen solos en el calendario Taskbot (`/calendar.ics`). Si los quieres en un calendario aparte, con su
color, suscribe `/cal/notion.ics?t=CAL_TOKEN` (y entonces verás cada uno dos veces si mantienes los dos).

### Modelo más rápido (Groq, gratis)
El asistente usa gpt-oss-120b en Workers AI (unos 370 de las 10.000 neuronas gratis al día por mensaje). Con una
clave gratuita de [console.groq.com](https://console.groq.com) va más rápido y no gasta neuronas:
```bash
npx wrangler secret put GROQ_API_KEY
```
⏸ La clave se pega en el prompt de ese comando, nunca en un archivo ni en un chat.

### Resumen semanal con repos privados
Token *fine-grained* de GitHub con permiso de solo lectura de contenido sobre tus repos y organizaciones:
```bash
npx wrangler secret put GITHUB_TOKEN
```

### Tu logo en el panel
Crea `public/brand/` con `mark.svg` (un `<symbol id="mark">`), `favicon.svg`, `apple-touch-icon.png` (180 px) e
`icon-512.png`. Sin esa carpeta se usan los de `public/brand.default/`. No se sube a git.

### Bandeja de tu web (mensajes y reservas)
Si tienes otro worker con un formulario o una agenda de reservas, puede empujar lo que llega al panel por un
service binding. El contrato está al principio de [`src/inbox.js`](src/inbox.js). Activa `panel.inbox: true`.
Si guardas datos de otras personas, dilo en tu política de privacidad.

### Correo (avisos y tareas de tu correo)
Necesitas un dominio en Cloudflare con **Email Routing** activado (gratis).
1. En `config.js`, el bloque `mail`: `address` (la dirección nueva), `forwarders` (tus cuentas), `watch`, `ignore`.
2. Despliega. En Cloudflare → tu dominio → Email → Email Routing → Routing rules → **Create address**: la dirección
   de `address` → acción **Send to a Worker** → `taskbot`.
3. Gmail → Configuración → Reenvío y correo POP/IMAP → **Añadir una dirección de reenvío** → la de `address`. El bot
   te manda por Telegram el código de confirmación. Después, marca "Reenviar una copia del correo entrante".
4. Prueba: escríbete desde Gmail a esa dirección con algo como "el lunes a las 10 tengo dentista".
Otras cuentas (la de la universidad, Outlook): una regla de reenvío a la misma dirección, si tu organización lo
permite, y añade la cuenta a `forwarders`.

### App y widget de macOS
Ver [`macos-widget/README.md`](macos-widget/README.md).

## Actualizar una instancia que ya existe
Aplica en orden las migraciones de `migrations/` que no tengas (los nombres llevan la fecha) y despliega:
```bash
npx wrangler d1 execute taskbot --remote --file=migrations/AAAA-MM-DD-nombre.sql
npx wrangler deploy
```
Si `config.example.js` tiene bloques nuevos, cópialos a tu `config.js`.

## Desarrollo local
```bash
npx wrangler d1 execute taskbot --local --file=schema.sql
npm run dev
```
Con `TG_DRY_RUN=1` en `.dev.vars` el bot no manda nada a Telegram: lo escribe en el log. Para probarlo:
```bash
curl -X POST http://localhost:8787/webhook -H "x-telegram-bot-api-secret-token: <TG_WEBHOOK_SECRET>" \
  -H "content-type: application/json" -d '{"message":{"chat":{"id":<OWNER_CHAT_ID>},"text":"¿qué tengo mañana?"}}'
```

## Comprobación final (Claude, sin preguntar)
- `wrangler.toml` tiene sus propios `database_id` e `id` de KV (ningún `RELLENAR`).
- `git status` no muestra `config.js`, `wrangler.toml`, `.dev.vars` ni `public/brand/`.
- Resume a la persona: la URL del panel, las URLs de calendario y que guarde `DASH_TOKEN` y `CAL_TOKEN` en su
  gestor de contraseñas: no están en ningún archivo.
