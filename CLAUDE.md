# CLAUDE.md — taskbot

Asistente personal en Telegram + panel web (PWA) sobre Cloudflare Workers, todo en la capa gratuita.

## Contexto rápido
- **Stack:** Cloudflare Workers (JS vanilla, sin build ni dependencias npm), D1, KV, Workers AI (gpt-oss-120b para el asistente, Llama 3.3 70B para clasificar y redactar, Whisper para audios, toMarkdown para PDFs), cron triggers. Panel: PWA vanilla en `public/` (módulos ES, sin frameworks).
- **Decisión clave:** la captura se queda en Telegram (cero fricción); el panel es para ver y organizar. No añadir fricción a la captura.
- **Todo en capa gratuita.** No introducir dependencias de pago sin avisar. Groq (GROQ_API_KEY) es opcional y gratis.
- **Módulos opcionales** (se apagan quitando su bloque de `config.js`): horario UC3M (`uc3m`), Moodle (`aulaGlobal`), resumen semanal (`weekly`), asistente de X (`social`), bandeja de la web (`panel.inbox`).

## Validación
- No hay tests. Validar con:
  - `node --input-type=module --check < src/ARCHIVO.js` (sintaxis)
  - `npx esbuild src/index.js --bundle --format=esm --outfile=/dev/null` (imports)
  - En local: `npm run dev` con `TG_DRY_RUN=1` en `.dev.vars` (el bot escribe en el log en vez de mandar a Telegram) y POST a `/webhook` con un update de prueba.
  - `npx wrangler deploy` despliega (requiere login del usuario).
- Los secretos viven en Cloudflare, nunca en el repo (lista en `.dev.vars.example`).
- Lo personal no se sube a git: `config.js`, `wrangler.toml`, `public/brand/`, `macos-widget/Local.xcconfig` y `macos-widget/Shared/TaskbotEndpoint.swift`. Si cambias su forma, actualiza su `.example` (o `public/brand.default/`, `macos-widget/Config.xcconfig`).

Si existe `CLAUDE.local.md` (no se sube a git), léelo también: son las notas de trabajo de quien lo mantiene.
