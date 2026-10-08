# Guía de uso de taskbot

> Resumen del proyecto en inglés: [README](../README.md). Montar tu copia: [DEPLOY.md](../DEPLOY.md).

Sustituye el chat de WhatsApp contigo mismo: mandas texto, fotos, audios o archivos a un **bot de Telegram** (misma fricción cero que WhatsApp) y todo aparece organizado en un **dashboard PWA** instalable en el iPhone. La IA clasifica automáticamente cada mensaje y el bot te recuerda cada mañana lo que vence o lleva demasiado tiempo pendiente.

**Coste: 0€/mes**: todo corre en la capa gratuita de Cloudflare (Workers + D1 + KV + Workers AI).

## Cómo funciona

```
Telegram (tú) ──▶ Worker /webhook ──▶ IA clasifica ──▶ D1 (tareas) + KV (archivos)
                                                          ▲
Dashboard PWA (iPhone/PC) ◀── Worker /api ────────────────┘
Cron diario 8:00 ──▶ bot te escribe: vence hoy / atrasado / lleva 2 semanas
```

- **Texto** → la IA detecta: tarea/nota/material, prioridad (urgente/normal/algún día), categoría y fecha límite ("el viernes" → fecha real). Si la IA falla, se guarda como tarea normal — nunca se pierde nada.
- **Fotos/audios/archivos** → se guardan en KV y salen en la pestaña Material (o asociados a la tarea si llevan caption).
- El bot confirma cada captura con botones: ✅ Hecha · 🔥 Urgente · 🌙 Algún día · 🗑 Borrar.
- Comandos: `/hoy` y `/manana` (agenda con huecos libres), `/semana` (huecos de 7 días), `/lista` (pendientes), `/planificar` (coloca las tareas sin hueco), `/ayuda`.

## Asistente

Cada texto o audio pasa por `src/assistant.js`, que decide (Workers AI, Llama 3.3 70B):
- **pregunta** → responde con la agenda real del rango de días que haga falta, exámenes, tareas, avisos y notas de Aula Global. Recuerda los últimos mensajes (KV `chat:history`, 3 h) para seguir la conversación ("¿y el viernes?").
- **editar** → mueve, renombra o cambia la fecha límite de una tarea, evento o examen, con botón ↩️ Deshacer (estado anterior en KV `undo:<id>`, 2 días). Mover un examen devuelve la clase a ese día.
- **borrar** → pide confirmación. **hecho** → marca hecho (con ↩️).
- **apuntar** → el flujo de siempre (`classify` → evento/tarea/examen/cancelación).
Si algo falla, el bot lo dice en vez de quedarse callado.

## Asistente de X

No publica nada ni va por horarios: te avisa cuando hay algo que merece un post y te escribe borradores. Código en `src/social.js`; fuentes, cadencia y "voz" en `config.js` (`social`).

- **Cada hora lee** las fuentes (blogs oficiales, blogs que sigues, Hacker News, GitHub Trending, Product Hunt) y les pone **temperatura**: puntos de HN por hora, estrellas de hoy, lanzamiento oficial reciente y, sobre todo, **el mismo tema en varias fuentes a la vez** (señal de que está pegando).
- **Noticias al momento** (fuentes con `news`: OpenAI, Anthropic, DeepMind, Gemini, Claude Code, Cursor, GitHub, Qwen, Apple Developer, Rust): la IA descarta lo menor (clientes, alianzas, versiones con solo arreglos) y lo demás llega en menos de una hora como "🗞 Anthropic ha publicado…", sin esperar a la cadencia. Lo de la noche llega junto a las 9 ("Mientras dormías").
- **La IA mira lo más caliente** y decide si algo merece post ahora, por qué y con qué ángulo.
- **Cadencia** (`social.cadence`): un aviso cada 20–44 h, máximo 2 al día, nada entre las 23 y las 9. Antes de 20 h solo si es algo gordo; pasadas 44 h baja el listón.
- El aviso trae ✍️ Borrador (dos versiones para citar), ⭐ Guardar, ✅ Publicado y ⏭ Paso.
- **Eventos tech de Madrid** (Luma y Meetup, filtrados por la IA): se miran una vez al día y solo avisa de los nuevos; ➕ los mete en el calendario y al acabar pregunta si da para post.

Comandos: `/post idea` (dos versiones; vale como pie de foto), `/radar` (lo más caliente ahora), `/cita N` y `/guardar N` sobre el radar, `/hilo` (hilo con lo guardado).

## Agenda: el "cerebro"

taskbot conoce todo el horario (clases UC3M + rutina + eventos + exámenes) y coloca cada cosa:

| Mandas por Telegram | Pasa |
|---|---|
| "Reunión con Marco el jueves a las 17:30" | 📅 evento con hora y alarma; avisa si choca con algo |
| "Hacer la práctica de SO antes del viernes" | 📌 tarea; la IA estima la duración y la pone en un hueco libre antes de la fecha (🔁 para moverla) |
| "Parcial de Cálculo el 26 de octubre a las 10:45" | 📝 examen; en el calendario sustituye a la clase de esa asignatura |
| "Este sábado no hay partido" / "no hay clase de IA el martes" | ❌ quita ese partido, entreno o clase (↩️ Deshacer) |
| "Partido el sábado 17 a las 11 en Illescas" | sustituye al bloque provisional de partidos de ese sábado |

Aula Global: **cada hora** entregas y cuestionarios pendientes → tareas con hueco, entregado → hecha, cambio de fecha → aviso, recordatorios 24 h y 3 h antes, avisos y foros de los profesores → Telegram; **cada 3 h** material nuevo y notas publicadas → aviso. Necesita el secreto `AULAGLOBAL_TOKEN` (token de la app móvil de Moodle); sin él, esta parte se desactiva.

Crons (la cuenta gratuita permite 5 en total entre todos los workers; aquí 3): `0 6 * * *` buenos días · `15 * * * *` Aula Global · `45 * * * *` horario UC3M (hora UTC % 3 = 0) o material y notas (% 3 = 1).

Cada 3 h (minuto 45) se relee la web de horarios de la UC3M (avisa por Telegram de cambios de aula, sesiones nuevas o quitadas) y se recolocan las tareas que se pasaron o que ahora chocan.

### Calendarios suscritos (Apple Calendar, solo lectura)

Todos con el mismo `CAL_TOKEN` (`?t=...`):

| URL | Calendario |
|---|---|
| `/cal/clases.ics` | **UC3M · Clases**: clases de teoría y recuperaciones |
| `/cal/practicas.ics` | **UC3M · Prácticas** (naranja): prácticas/laboratorios + fechas límite ⏰ de Aula Global |
| `/cal/examenes.ics` | **UC3M · Exámenes** (rojo): parciales, controles, EC y finales |
| `/cal/rutina.ics` | **Rutina**: la rutina semanal de `config.js`, sin festivos ni vacaciones |
| `/calendar.ics` | **Taskbot**: eventos y bloques de tareas |

Para que salgan en el iPhone: Calendario del Mac → Archivo → Nueva suscripción → ubicación **iCloud**, actualización **cada hora**. Los calendarios suscritos no se pueden editar desde Apple: los cambios se hacen por Telegram.

### Configuración

Todo lo personal vive en `config.js` (no se sube a git; plantilla en `config.example.js`):
- `uc3m`: asignaturas y grupos (cambiar si cambia la matrícula).
- `routine`: rutina semanal, festivos y vacaciones.
- `prefs`: ventana de planificación, comida, viajes.
- `aulaGlobal.year` y `calendar.uidDomain`.

## Despliegue

Paso a paso en [DEPLOY.md](../DEPLOY.md) (~15 min, sin tarjeta).

## Recordatorios

Cada día a las **8:00 (verano) / 7:00 (invierno)** el bot te manda:
- 🗓 La agenda del día (clases con aula, entrenos, eventos, bloques de tareas) y los huecos libres.
- ⚠️ Tareas atrasadas, 📅 las que vencen hoy y 🔜 mañana.
- 🕸 Tareas sin fecha con más de 2 semanas pendientes (máx. 5, se repite semanalmente).

Para cambiar la hora: edita `crons` en `wrangler.toml` (está en UTC) y redespliega.

## Estructura

```
src/index.js      router del Worker, crons y archivos (KV)
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
src/aulaglobal.js Aula Global: entregas, recordatorios, avisos, material y notas
src/assistant.js  asistente: preguntas, cambios y deshacer
public/           dashboard PWA (vanilla JS, sin dependencias)
schema.sql        esquema D1
```

## Límites de la capa gratuita (de sobra para uso personal)

| Recurso | Gratis | Tu uso estimado |
|---|---|---|
| Workers | 100.000 req/día | < 500 |
| D1 | 5 GB, 5M lecturas/día | irrisorio |
| KV | 1 GB | años de fotos |
| Workers AI | ~10.000 neuronas/día | ~100 clasificaciones/día posibles |

## Más funciones

- **Transcripción de audios con Whisper** — notas de voz cortas (≤5 min) se transcriben (`@cf/openai/whisper-large-v3-turbo`, gratis en Workers AI) y se clasifican igual que un mensaje de texto. Si falla, cae a "material" como antes.
- **Búsqueda en el dashboard** — campo de búsqueda bajo el quick-add, filtra todo (pendientes y hechas, cualquier tipo) por texto y categoría.
- **Pestaña de categorías** — quinta tab "🏷 Cats", agrupa lo pendiente por categoría con contadores y grupos colapsables.
- Compartir directo desde iOS al bot — ya funciona sin cambios: Compartir → Telegram → tu bot.

## Widget para el escritorio del Mac

Hay una app auxiliar nativa con widget de macOS en [`macos-widget/`](../macos-widget/README.md). Copia `Shared/TaskbotEndpoint.swift.example` a `Shared/TaskbotEndpoint.swift` con la URL de tu worker, abre el proyecto con Xcode, configura la firma del grupo de aplicaciones, introduce tu `DASH_TOKEN` y añade el widget desde el Centro de notificaciones. Ofrece tamaños pequeño, mediano y grande, muestra tareas pendientes y abre el dashboard al pulsarlo. El sistema de widgets decide el intervalo real de actualización.

Desde el widget de macOS puedes pulsar el círculo de una tarea para marcarla como hecha; se quita de la lista pendiente al actualizar. El widget tiene espacio fijo (hasta 7 tareas en grande), así que púlsalo fuera de los botones para abrir el dashboard y desplazarte por todas.
