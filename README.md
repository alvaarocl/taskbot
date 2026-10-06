# Taskbot — captura sin fricción + dashboard de tareas

Sustituye el chat de WhatsApp contigo mismo: mandas texto, fotos, audios o archivos a un **bot de Telegram** (misma fricción cero que WhatsApp) y todo aparece organizado en un **dashboard PWA** instalable en el iPhone. La IA clasifica automáticamente cada mensaje y el bot te recuerda cada mañana lo que vence o lleva demasiado tiempo pendiente.

**Coste: 0€/mes** — todo corre en la capa gratuita de Cloudflare (Workers + D1 + R2 + Workers AI).

> **¿Quieres tu propia copia independiente (para probarlo sin mezclar datos con otra persona)?** Abre este repo con Claude Code y dile: *"sigue DEPLOY.md paso a paso"*. Monta un bot, base de datos y dashboard 100% tuyos, sin tocar ninguna otra instancia.

## Cómo funciona

```
Telegram (tú) ──▶ Worker /webhook ──▶ IA clasifica ──▶ D1 (tareas) + R2 (archivos)
                                                          ▲
Dashboard PWA (iPhone/PC) ◀── Worker /api ────────────────┘
Cron diario 8:00 ──▶ bot te escribe: vence hoy / atrasado / lleva 2 semanas
```

- **Texto** → la IA detecta: tarea/nota/material, prioridad (urgente/normal/algún día), categoría y fecha límite ("el viernes" → fecha real). Si la IA falla, se guarda como tarea normal — nunca se pierde nada.
- **Fotos/audios/archivos** → se guardan en R2 y salen en la pestaña Material (o asociados a la tarea si llevan caption).
- El bot confirma cada captura con botones: ✅ Hecha · 🔥 Urgente · 🌙 Algún día · 🗑 Borrar.
- Comandos: `/hoy` y `/manana` (agenda con huecos libres), `/semana` (huecos de 7 días), `/lista` (pendientes), `/planificar` (coloca las tareas sin hueco), `/ayuda`.

## Agenda: el "cerebro"

taskbot conoce todo el horario (clases UC3M + rutina + eventos + exámenes) y coloca cada cosa:

| Mandas por Telegram | Pasa |
|---|---|
| "Reunión con Marco el jueves a las 17:30" | 📅 evento con hora y alarma; avisa si choca con algo |
| "Hacer la práctica de SO antes del viernes" | 📌 tarea; la IA estima la duración y la pone en un hueco libre antes de la fecha (🔁 para moverla) |
| "Parcial de Cálculo el 26 de octubre a las 10:45" | 📝 examen; en el calendario sustituye a la clase de esa asignatura |
| "Este sábado no hay partido" / "no hay clase de IA el martes" | ❌ quita ese partido, entreno o clase (↩️ Deshacer) |
| "Partido el sábado 17 a las 11 en Illescas" | sustituye al bloque provisional de partidos de ese sábado |

Cada 3 h se relee la web de horarios de la UC3M (avisa por Telegram de cambios de aula, sesiones nuevas o quitadas) y se recolocan las tareas que se pasaron o que ahora chocan.

### Calendarios suscritos (Apple Calendar, solo lectura)

Todos con el mismo `CAL_TOKEN` (`?t=...`):

| URL | Calendario |
|---|---|
| `/cal/clases.ics` | **UC3M · Clases**: clases, laboratorios, recuperaciones y exámenes |
| `/cal/rutina.ics` | **Rutina**: entrenos y partidos según el calendario escolar de Toledo |
| `/calendar.ics` | **Taskbot**: eventos y bloques de tareas |

Para que salgan en el iPhone: Calendario del Mac → Archivo → Nueva suscripción → ubicación **iCloud**, actualización **cada hora**. Los calendarios suscritos no se pueden editar desde Apple: los cambios se hacen por Telegram.

### Configuración

- Asignaturas y grupos: `UC3M_CONFIG` en `src/uc3m.js` (cambiar si cambia la matrícula).
- Horario de baloncesto, festivos y vacaciones: `ROUTINE` en `src/rutina.js`.
- Ventana de planificación, comida, viajes: `PREFS` en `src/brain.js`.

## Despliegue (una sola vez, ~15 min)

Requisitos: cuenta de Cloudflare (ya la tienes), Node instalado.

### 1. Crear el bot de Telegram
1. En Telegram, habla con **@BotFather** → `/newbot` → dale nombre y username.
2. Guarda el **token** que te da.
3. Opcional: `/setuserpic` para ponerle icono.

### 2. Crear los recursos en Cloudflare
```bash
cd taskbot
npx wrangler login                          # abre el navegador, autoriza

npx wrangler d1 create taskbot              # copia el database_id que devuelve
# → pégalo en wrangler.toml donde pone PON_AQUI_EL_DATABASE_ID

npx wrangler r2 bucket create taskbot-files
npx wrangler d1 execute taskbot --remote --file=schema.sql
```

### 3. Configurar secretos
```bash
npx wrangler secret put TELEGRAM_TOKEN      # el token de BotFather
npx wrangler secret put TG_WEBHOOK_SECRET   # inventa una cadena aleatoria larga
npx wrangler secret put DASH_TOKEN          # tu contraseña del dashboard (aleatoria y larga)
```

### 4. Desplegar y conectar el webhook
```bash
npx wrangler deploy                         # te da la URL: https://taskbot.XXX.workers.dev
```
Registra el webhook (sustituye TOKEN, URL y SECRETO):
```bash
curl "https://api.telegram.org/botTOKEN/setWebhook?url=https://taskbot.XXX.workers.dev/webhook&secret_token=SECRETO"
```

### 5. Activar tu chat
1. Escríbele cualquier cosa al bot → te responde con tu **chat id**.
2. `npx wrangler secret put OWNER_CHAT_ID` → pega el número.
3. Vuelve a escribirle: ya guarda de verdad. El bot es privado — ignora a cualquier otro usuario.

### 6. Instalar el dashboard en el iPhone
1. Abre la URL del worker en Safari.
2. Introduce tu `DASH_TOKEN`.
3. Compartir → **Añadir a pantalla de inicio**. Ya tienes la app.

### 7. (Opcional) Tu dominio
En `wrangler.toml`, descomenta `routes` y pon p. ej. `tareas.tudominio.com` → `npx wrangler deploy`. Cloudflare crea el DNS solo (el dominio ya está en tu cuenta).

## Recordatorios

Cada día a las **8:00 (verano) / 7:00 (invierno)** el bot te manda:
- 🗓 La agenda del día (clases con aula, entrenos, eventos, bloques de tareas) y los huecos libres.
- ⚠️ Tareas atrasadas, 📅 las que vencen hoy y 🔜 mañana.
- 🕸 Tareas sin fecha con más de 2 semanas pendientes (máx. 5, se repite semanalmente).

Para cambiar la hora: edita `crons` en `wrangler.toml` (está en UTC) y redespliega.

## Estructura

```
src/index.js      router del Worker + servir archivos R2
src/telegram.js   webhook: mensajes, adjuntos, botones, comandos
src/classify.js   clasificación con Workers AI (tarea/evento/examen/cancelación, duración)
src/api.js        API REST para el dashboard
src/reminders.js  cron diario: agenda + recordatorios; avisos de tareas recolocadas
src/brain.js      agenda, huecos libres, colocar y recolocar tareas
src/uc3m.js       lector de la web de horarios UC3M
src/sync.js       cron cada 3 h: horario UC3M en KV + avisos de cambios
src/rutina.js     rutina semanal (baloncesto) y calendario escolar
src/exams.js      exámenes que sustituyen a la clase
src/overrides.js  lo fijo ajustado con exámenes y cancelaciones
src/calendar.js   feeds .ics
public/           dashboard PWA (vanilla JS, sin dependencias)
schema.sql        esquema D1
```

## Límites de la capa gratuita (de sobra para uso personal)

| Recurso | Gratis | Tu uso estimado |
|---|---|---|
| Workers | 100.000 req/día | < 500 |
| D1 | 5 GB, 5M lecturas/día | irrisorio |
| R2 | 10 GB almacenamiento | años de fotos |
| Workers AI | ~10.000 neuronas/día | ~100 clasificaciones/día posibles |

## Funciones adicionales (implementadas 2026-07-12)

- **Transcripción de audios con Whisper** — notas de voz cortas (≤5 min) se transcriben (`@cf/openai/whisper-large-v3-turbo`, gratis en Workers AI) y se clasifican igual que un mensaje de texto. Si falla, cae a "material" como antes.
- **Búsqueda en el dashboard** — campo de búsqueda bajo el quick-add, filtra todo (pendientes y hechas, cualquier tipo) por texto y categoría.
- **Pestaña de categorías** — quinta tab "🏷 Cats", agrupa lo pendiente por categoría con contadores y grupos colapsables.
- Compartir directo desde iOS al bot — ya funciona sin cambios: Compartir → Telegram → tu bot.

## Ideas futuras (no en v1)

- Dominio propio — ver sección "(Opcional) Tu dominio" más arriba, deliberadamente sin activar por defecto.

## Widget para el escritorio del Mac

Hay una app auxiliar nativa con widget de macOS en [`macos-widget/`](macos-widget/README.md). Abre el proyecto con Xcode, configura la firma del grupo de aplicaciones, introduce tu `DASH_TOKEN` y añade el widget desde el Centro de notificaciones. Ofrece tamaños pequeño, mediano y grande, muestra tareas pendientes y abre el dashboard al pulsarlo. El sistema de widgets decide el intervalo real de actualización.

Desde el widget de macOS puedes pulsar el círculo de una tarea para marcarla como hecha; se quita de la lista pendiente al actualizar. El widget tiene espacio fijo (hasta 7 tareas en grande), así que púlsalo fuera de los botones para abrir el dashboard y desplazarte por todas.
