# CLAUDE.md — taskbot

Bot de Telegram + dashboard PWA para captura de tareas sin fricción. Sustituye el chat de WhatsApp con uno mismo.

## Contexto rápido
- **Stack:** Cloudflare Workers (JS vanilla, sin build), D1, KV, Workers AI (Llama 3.3 70B + Whisper, gratis), cron triggers. Dashboard: PWA vanilla en `public/`, sin frameworks ni dependencias.
- **Decisión clave:** la captura se queda en Telegram (cero fricción, como WhatsApp); el dashboard es solo para visualizar/organizar. No añadir fricción a la captura jamás.
- **Todo en capa gratuita.** No introducir dependencias de pago sin avisar.

## Validación
- No hay tests. Validar con:
  - `node --input-type=module --check < src/ARCHIVO.js` (sintaxis)
  - `npx esbuild src/index.js --bundle --format=esm --outfile=/dev/null` (imports)
  - `npx wrangler deploy` despliega (requiere login del usuario)
- Los secretos (TELEGRAM_TOKEN, TG_WEBHOOK_SECRET, DASH_TOKEN, CAL_TOKEN, OWNER_CHAT_ID, AULAGLOBAL_TOKEN) viven en Cloudflare, no en el repo.
- Lo personal (matrícula, rutina, preferencias) va en `config.js`, y la URL del worker para la app de Mac en `macos-widget/Shared/TaskbotEndpoint.swift`. Ninguno de los dos se sube a git: el repo es público. Si cambias su forma, actualiza `config.example.js` / `TaskbotEndpoint.swift.example`.

## Protocolo Obsidian
Al terminar una sesión de trabajo: actualizar `Estado.md` y crear/actualizar `Sesiones/YYYY-MM-DD.md` con lo hecho y el próximo paso. Ambos están en .gitignore (notas personales, fuera del repo público).
