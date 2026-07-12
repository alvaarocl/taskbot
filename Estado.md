# Estado — taskbot

**Última actualización:** 2026-07-12 (sesión 2)

## ✅ MVP completo y verificado en producción

- Código completo: bot Telegram + IA + API + dashboard PWA + recordatorios
- **Desplegado en producción:** `https://taskbot.alvarocarpintero2.workers.dev`
- Base de datos D1 creada con esquema aplicado (id: `c5a351f4-2f41-4181-aa04-f310dcda4318`)
- Archivos en **KV** (id: `ec280c8780cc45d4aaf3e1007b9b6959`) — se descartó R2 porque pedía tarjeta; KV es gratis sin tarjeta (1 GB)
- Secretos configurados: `TELEGRAM_TOKEN`, `TG_WEBHOOK_SECRET`, `DASH_TOKEN`, `OWNER_CHAT_ID` (activado 2026-07-12)
- Webhook de Telegram registrado y verificado
- Clasificación IA **probada y funcionando** con `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
  (el modelo original llama-3.1-8b estaba deprecado desde 2026-05-30; si vuelve a pasar: `npx wrangler ai models`)
- Cron diario a las 06:00 UTC (8:00 verano) programado
- Dashboard instalado como PWA en el iPhone
- **Batería de pruebas v1: todo funciona** — fechas relativas, urgente, algún día, fotos/material, botón Hecha, `/lista`, edición desde dashboard

## 🔑 Credenciales

- Todos los secretos (`TELEGRAM_TOKEN`, `TG_WEBHOOK_SECRET`, `DASH_TOKEN`, `CAL_TOKEN`, `OWNER_CHAT_ID`) viven **solo en Cloudflare** (`npx wrangler secret put ...`) — nunca en este repo. Si necesitas recuperar alguno, consulta el gestor de contraseñas o Cloudflare dashboard → Workers → taskbot → Settings → Variables.
- ⚠️ El token del bot quedó pegado en una conversación de Claude en su día. Rotar cuando haya tiempo: @BotFather → `/revoke` → `npx wrangler secret put TELEGRAM_TOKEN` → volver a registrar el webhook

## ✅ Feed de calendario (.ics) — implementado 2026-07-12

- Endpoint `/calendar.ics` en `src/calendar.js`, montado en `src/index.js`
- Lee D1: solo tareas `kind='tarea'`, `status='pendiente'`, con `due_date` no nulo
- Protegido con secreto propio `CAL_TOKEN` (separado de `DASH_TOKEN` a propósito: esta URL la guarda y consulta periódicamente la infraestructura de Apple, así que si se filtra solo hay que rotar este token, no el del dashboard)
- Probado: token válido devuelve VCALENDAR válido, token inválido → 403
- **URL de suscripción (Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Calendario suscrito):**
  `https://taskbot.alvarocarpintero2.workers.dev/calendar.ics?t=TU_CAL_TOKEN` (valor real en el gestor de contraseñas, no en el repo)
- Limitaciones conocidas (aceptadas): solo lectura y de una dirección (taskbot → Calendario, no al revés); refresco no instantáneo, lo controla Apple
- Falta confirmar en el propio iPhone que la suscripción se ve bien con una tarea real de fecha próxima

## ✅ Búsqueda y vista de categorías — implementado y desplegado 2026-07-12 (sesión 2)

- **Búsqueda client-side:** `#search-input` en el header (bajo el quick-add). Filtra globalmente (pendientes + hechas, cualquier kind) sobre `text` y `category` con normalización NFD (ignora acentos/mayúsculas). Cuando hay query activa, se muestra lista plana (sin agrupado por prioridad) y cada item lleva chip de su kind (📌/📝/📎).
- **Tab "🏷 Cats":** quinta pestaña. Agrupa items pendientes de cualquier kind por categoría, orden alfabético, "Sin categoría" al final. Grupos colapsables (▸/▾) con contador. Items muestran chip de kind.
- **Service worker:** bumpeado a `taskbot-v2` para forzar refresco del shell cacheado.

## ✅ Transcripción de audios con Whisper — implementado y desplegado 2026-07-12 (sesión 2)

- Notas de voz/audio de Telegram (≤5 min, sin caption) se transcriben con `@cf/openai/whisper-large-v3-turbo` (Workers AI, gratis).
- **Probado en producción por Álvaro:** la transcripción funciona bien (OGG/Opus de Telegram se digiere sin problema).
- El audio original se guarda siempre en KV, con una copia independiente por cada tarea creada (para que borrar una no deje sin adjunto a las demás).
- No se creó columna nueva en `items`: el texto reutiliza la columna `text` existente.

### Ajuste 2026-07-12 (sesión 3): extracción de tareas, no transcript literal
Problema detectado: el transcript se guardaba palabra por palabra (con saludos y relleno, ej. "hola este es un audio de prueba mañana de entrenamiento a las 9" quedaba entero como texto de la tarea) y nunca se separaba en varias tareas si el audio mencionaba más de una cosa.

Solución: nueva función `classifyAudioTranscript()` en `src/classify.js` — la IA extrae del transcript 1 o varias tareas/notas ya limpias (sin relleno ni saludos), cada una clasificada por separado (kind/prioridad/categoría/fecha). Si la extracción falla, cae al transcript completo como único item (fail-safe, nunca se pierde el audio). Cada tarea creada se envía como un mensaje de confirmación independiente con sus propios botones; el transcript original se muestra una sola vez, en el primer mensaje.

## Pendiente menor
- Probar en vivo un audio con VARIAS tareas mezcladas (ej. "recuérdame llamar a Juan y también comprar leche mañana") y confirmar que las separa bien
- Comprobar el recordatorio matutino en vivo (llega solo a las ~8:00; nunca se ha visto disparar en producción)
- Revisar visualmente en el iPhone que caben bien los 5 botones de la barra de tabs

## Ideas aparcadas (no hacer aún)
- Dominio propio (`routes` comentado en wrangler.toml) — se deja tal cual a propósito, no se ha tocado
