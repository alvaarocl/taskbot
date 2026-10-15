# Guía de uso de taskbot

> Resumen del proyecto en inglés: [README](../README.md). Montar tu copia: [DEPLOY.md](../DEPLOY.md).

Un asistente personal en **Telegram** (la misma fricción cero que escribirte a ti mismo por WhatsApp) y un **panel
web** instalable en el iPhone. Le mandas cualquier cosa (una frase, un audio, un email pegado, la info de un evento)
y lo entiende, lo apunta en tu agenda respetando tus pautas y te avisa de lo que choca. También responde preguntas
con tus datos reales: tu horario, tus entregas o lo que dice el profe en Moodle que toca mañana.

**Coste: 0 €/mes**: capa gratuita de Cloudflare (Workers, D1, KV, Workers AI) y, si quieres, Groq gratis.

## Cómo funciona

```
Telegram (tú) ──▶ Worker /webhook ──▶ asistente (gpt-oss-120b + herramientas) ──▶ D1 + KV
                                         │  agenda · huecos · choques · Moodle
Panel PWA (passkey) ◀──── Worker /api ───┘
Crons ──▶ Moodle cada hora · horario cada 3 h · buenos días 7:45 · resumen del domingo
```

## El asistente

Cada texto o audio lo lee un modelo con herramientas (`src/agent.js`). Tiene delante el calendario de las dos
próximas semanas ya resuelto y todo lo que tienes guardado, y decide qué hacer:

| Le mandas | Hace |
|---|---|
| "Reunión con Ana el jueves a las 17:30" | 📅 evento con alarma; avisa si choca con algo |
| "Tengo que hacer la práctica de SO antes del viernes, me llevará 3 horas" | 📌 tarea con un bloque de 3 h en un hueco libre antes de la fecha |
| La info de una hackathon: "del 8 al 12 de noviembre, horarios por confirmar, entrega el 11 a las 23:59" | 📅 cinco días completos *horario por confirmar*, la entrega como fecha límite (sin reservarle tiempo) y aviso de lo que choca (un examen, clases). Tres días antes te pregunta el horario |
| "El primer día de 17 a 22, los del medio de 9 a 21 y el último hasta las 14" | 🕐 pone esas horas a cada día del evento |
| Un email reenviado o pegado | 📥 saca todas las reuniones y tareas que haya |
| "¿Qué vamos a hacer mañana en Ingeniería del Software?" | 📚 mira tu horario y la planificación de la asignatura en Moodle (lee el PDF del calendario del profe) y te dice el tema de la sesión y si hay ejercicio en clase |
| "¿Qué tengo el viernes?" · "¿Tengo hueco el jueves por la tarde?" | 💬 responde con tu agenda real, horas exactas |
| "Parcial de Cálculo el 26 de octubre a las 10:45" | 📝 examen; en el calendario sustituye a la clase de esa asignatura |
| "Este sábado no hay partido" · "no hay clase de IA el martes" | ❌ quita ese partido, entreno o clase |
| "Mueve la reunión con Ana a las 18" · "ya entregué la práctica" · "borra la cena del jueves" | ✏️ cambia, marca hecho o pide confirmar el borrado con un botón |
| "Apúntame la cena con mis padres" | ❓ te pregunta el día y la hora en vez de inventárselos |

Cada mensaje acaba con un botón **↩️ Deshacer** que revierte todo lo que hizo ese mensaje (2 días). Recuerda la
conversación de las últimas 24 h, así que entiende "ponlo a las 18" o "¿y el lunes?".

**Modelo:** gpt-oss-120b (abierto, con razonamiento y herramientas). Primero en Groq si hay `GROQ_API_KEY`
(rápido y sin gastar cuota de Cloudflare); si no, o si falla, el mismo modelo en Workers AI (unas 370 neuronas por
mensaje de las 10.000 gratis al día). Los audios se transcriben con Whisper, también en Groq si hay clave.

**Sin cuota de IA** (se acaban las neuronas del día o el límite de Groq): el bot te avisa, se guarda el mensaje o el
audio y lo procesa solo cuando vuelve la cuota (las 00:00 UTC, las 2:00 en Madrid en verano), contestándote
entonces; las fechas como "mañana" se entienden respecto al día en que lo mandaste. Si el modelo falla por otra
cosa, el mensaje se guarda como tarea normal: nunca se pierde nada.

**Fotos y archivos** se guardan (KV) y salen en el panel; con pie de foto, como parte de esa tarea o nota.

**Comandos:** `/hoy` y `/manana` (agenda con huecos), `/semana` (huecos de 7 días), `/lista` (pendientes),
`/planificar` (coloca las tareas sin hueco), `/resumen` (resumen de la semana), `/acceso` (enlace para entrar al
panel), `/ayuda`.

## Agenda: el "cerebro"

taskbot junta tu horario fijo (clases, rutina semanal de `config.js`), exámenes, eventos y bloques de tareas, y
coloca cada tarea en el primer hueco libre antes de su fecha límite respetando tus pautas (`config.prefs`): horas
en las que se puede planificar, comida, desplazamientos antes de clase o de entrenar y huecos mínimos.

- **Exámenes y cancelaciones** van por encima del horario fijo: deshacer uno o mover un examen devuelve la clase.
- **Eventos de varios días** se guardan como un día por fila, unidos en una serie. Los días completos sin
  horario ocupan la jornada: ese día no se te colocan tareas.
- Si el horario de la uni cambia, las tareas que ahora chocan se recolocan.

## Moodle (opcional)

Con el secreto `AULAGLOBAL_TOKEN` (cómo sacarlo en [DEPLOY.md](../DEPLOY.md)) y `aulaGlobal` en `config.js`. Solo
lee: nunca entrega ni publica nada.

- **Cada hora:** entregas y cuestionarios pendientes → tareas con hueco; entregado → hecha; cambio de fecha → aviso;
  recordatorios 24 h y 3 h antes; avisos y foros de los profesores → Telegram.
- **Cada 3 h:** material nuevo y notas publicadas → aviso.
- **Bajo demanda:** el asistente lee el contenido de una asignatura (semanas, actividades con fechas, instrucciones,
  avisos) y sus documentos de planificación en PDF (calendario de sesiones, cronograma), que se convierten a texto
  con Workers AI y se guardan hasta que el profe los cambie.

## Notion (opcional)

Para el Notion de un equipo o asociación (secreto `NOTION_TOKEN`; `notion` en `config.js` con los nombres de tus
bases y campos). Solo lee:

- **Eventos:** las filas con fecha cuyo tipo es un evento salen con 🚀 en el calendario **Taskbot** que ya tienes
  suscrito (y, si los quieres aparte con su color, en `/cal/notion.ics`: suscribe uno u otro, no los dos), leídos de
  Notion cada vez que el calendario se actualiza, y en tu agenda. Los que tienen hora ocupan ese hueco; los de días
  enteros se ven pero no te bloquean el día. Las filas repetidas se juntan.
- **Tareas:** las que te asignen (tu fila de miembro en el campo de asignación) llegan como tareas con hueco y aviso;
  al completarlas en Notion se cierran aquí, y si cambia la fecha te avisa. Se revisa cada hora.
- **Preguntas:** "¿qué hay que llevar a la jornada del sábado?", "¿quién da la formación del 24?": el asistente busca en Notion,
  lee las páginas y te contesta citándolas.

## Horario de la UC3M (opcional)

Con `uc3m` en `config.js`: cada 3 h relee la web pública de horarios, avisa de cambios de aula y de sesiones
nuevas o quitadas, y alimenta los calendarios de clases, prácticas y exámenes. Si no estudias en la UC3M, pon
`uc3m: null` y mete tus clases como rutina (`config.routine`) o como eventos.

## Calendarios suscritos (solo lectura)

Todos con el mismo `CAL_TOKEN` (`?t=...`):

| URL | Calendario |
|---|---|
| `/calendar.ics` | **Taskbot**: eventos y bloques de tareas |
| `/cal/rutina.ics` | **Rutina**: tu semana fija, sin festivos ni vacaciones |
| `/cal/clases.ics` | **Clases** (módulo uc3m) |
| `/cal/practicas.ics` | **Prácticas** (naranja): laboratorios + fechas límite ⏰ de Moodle |
| `/cal/examenes.ics` | **Exámenes** (rojo) |
| `/cal/notion.ics` | **Eventos de tu Notion** (morado; módulo notion) |

En el iPhone: Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Calendario suscrito (o, desde el Mac,
Archivo → Nueva suscripción en iCloud, actualización cada hora). Los cambios se hacen por Telegram.

## Buenos días

Cada día a las **7:45** (hora de Madrid, todo el año) el bot te manda la agenda del día con huecos libres, las
tareas atrasadas, las que vencen hoy y mañana, y las que llevan más de 2 semanas sin fecha (máx. 5, una vez por
semana). Si un evento sin horario empieza en 3 días o menos, te pregunta el horario.

Para cambiar la hora: `MORNING_HOUR_MADRID` en `src/index.js`.

## Cierre del día (opcional, `evening`)

A las **22:45** (`evening.hour`) te escribe lo que ha quedado pendiente: tareas que vencían hasta hoy y bloques de
hoy sin hacer (máx. 8). Cada una tiene ✅ y ➡️ a mañana; también hay ➡️ Todo a mañana y 👌 Lo dejo así. Si no queda
nada, no escribe.

- "A mañana": si tenía bloque, se le busca el primer hueco libre de mañana; si solo tenía fecha, pasa a mañana.
- Las entregas de la uni (Moodle, cronogramas) solo tienen ✅: su fecha no la decides tú.
- Lo que no toques sigue igual, y puedes contestar al asistente ("pasa lo de Cálculo al lunes").

## Correo (opcional, `mail`)

Tus cuentas reenvían el correo a una dirección tuya (`mail.address`, p. ej. `bandeja@tudominio.com`) que recibe el
worker con Cloudflare Email Routing. Por cada correo:

1. Solo se aceptan los reenviados por `mail.forwarders` (Gmail reenvía como `tu+caf_…@gmail.com`, y vale igual).
2. Fuera sin IA: boletines y listas (`List-Unsubscribe`, `List-Id`), respuestas automáticas y lo de `mail.ignore`.
   Lo de `mail.watch` (p. ej. `uc3m.es`) siempre lo mira la IA aunque parezca un boletín.
3. La IA (Groq, el modelo pequeño) decide si te pide algo o trae una fecha. Es muy selectiva.
4. Si importa: 📧 remitente, asunto, qué pasa y la propuesta (📌 tarea o 📅 evento) con **📌 Apuntar** /
   **✕ No hace falta**. Nunca apunta nada sola.

No se guarda el correo: solo remitente, asunto y la propuesta, 7 días (para el botón y para que Jarvis te lo
cuente por la mañana). Si la IA no responde, el texto recortado espera hasta 2 días y se reintenta en el cron de :15.

## Chequeo de salud (opcional, `health`)

A las **21:15** (`health.hour`) comprueba el webhook de Telegram, la clave de Groq, el token de Notion, la cola de
mensajes y Jarvis (token de GitHub, Modal y la sesión de la cuenta que llama). Solo escribe si algo falla, con cómo
arreglarlo. `/salud` lo hace en el momento y enseña también lo que va bien. Moodle no se mira aquí porque ya avisa
solo cuando caduca su token.

Jarvis, además, avisa si una llamada programada no llega a sonar (40 min después sin noticias de Modal ni de GitHub).

## Panel

Tres pestañas (las de módulos apagados no salen):

- **Hoy:** agenda con aulas y huecos libres, entregas de Moodle de los próximos 14 días, tareas con fecha de los
  próximos 7 días y la lista completa (alta rápida, búsqueda, filtros y edición). Las tareas van **por bloques**:
  primero la uni dividida por asignatura, luego cada categoría. Los bloques se pliegan y el panel lo recuerda.
- **Reuniones** (`panel.inbox`): mensajes y reservas que empuja otro worker tuyo (ver `src/inbox.js`).
- **Semana** (`weekly`): el resumen del domingo y su histórico, con un botón para copiar el borrador.

**Acceso:** passkey / Face ID. Sin passkey en el dispositivo: `/acceso` en Telegram manda un enlace de un solo uso
(10 min). Solo se pueden añadir passkeys en los 10 minutos siguientes a entrar; en ⋯ → Ajustes se ven y se quitan.

**Tu logo:** pon tus archivos en `public/brand/` (no se sube a git); si no, salen los de `public/brand.default/`.
Colores y tipografía en `public/style.css`.

## Resumen semanal (opcional)

El domingo a las **20:45** o con `/resumen`: tus commits de la semana y los de tus organizaciones
(`config.weekly`), las tareas cerradas, las clases por asignatura y un borrador de post *build in public*. Se
guarda (pestaña Semana) y llega por Telegram. Con `GITHUB_TOKEN` (fine-grained, solo lectura) entran los repos
privados.

## Asistente de X (opcional)

No publica nada ni va por horarios: te avisa cuando hay algo que merece un post y te escribe borradores. Código en
`src/social.js`; fuentes, cadencia y tu voz en `config.social`.

- **Cada hora lee** las fuentes (blogs oficiales, blogs que sigues, Hacker News, GitHub Trending, Product Hunt) y
  les pone **temperatura**: puntos de HN por hora, estrellas de hoy, lanzamiento oficial reciente y, sobre todo,
  **el mismo tema en varias fuentes a la vez**.
- **Noticias al momento** de las fuentes con `news`: la IA descarta lo menor y lo demás llega en menos de una hora.
  Lo de la noche llega junto a las 9.
- **Cadencia** (`social.cadence`): un aviso cada 20–44 h, máximo 2 al día, nada de noche.
- El aviso trae ✍️ Borrador (dos versiones), ⭐ Guardar, ✅ Publicado y ⏭ Paso.
- **Eventos tech de tu ciudad** (Luma y Meetup, `social.events`): solo los nuevos; ➕ los mete en el calendario.

Comandos: `/post idea`, `/radar`, `/cita N`, `/guardar N`, `/hilo`.

## Crons

La cuenta gratuita permite 5 en total entre todos tus workers; taskbot usa 2. `15 * * * *`: Moodle.
`45 * * * *`: horario (hora UTC % 3 = 0) o material y notas (% 3 = 1), asistente de X y, en hora de Madrid, buenos
días a las 7:45, limpieza a las 4:45, resumen el domingo a las 20:45 y cierre del día a las 22:45. El de `15` hace
también el chequeo de salud (21:15), la cola de mensajes y la de correos.

## Estructura

```
src/index.js      router del Worker, crons, archivos y logo
src/telegram.js   webhook: mensajes, adjuntos, botones, comandos
src/agent.js      el asistente: prompt, herramientas y bucle; ↩️ Deshacer conjunto
src/llm.js        gpt-oss-120b en Groq o Workers AI
src/assistant.js  piezas del asistente: lo guardado legible, calendario resuelto, cambios con deshacer
src/classify.js   clasificación de respaldo (Llama 3.3) y transcripción de audios (Whisper)
src/brain.js      agenda, huecos libres, colocar y recolocar tareas
src/reminders.js  buenos días y pregunta del horario pendiente
src/aulaglobal.js Moodle: entregas, recordatorios, avisos, material, notas y contenido de asignaturas
src/uc3m.js       lector de la web de horarios de la UC3M
src/sync.js       horario en KV y avisos de cambios
src/rutina.js     rutina semanal y calendario escolar
src/exams.js      exámenes que sustituyen a la clase
src/overrides.js  lo fijo ajustado con exámenes y cancelaciones
src/calendar.js   feeds .ics
src/api.js        API del panel (cookie de sesión o Bearer DASH_TOKEN)
src/auth.js       passkeys (WebAuthn a mano), sesiones y enlaces de /acceso
src/subjects.js   área y asignatura de cada tarea (bloques del panel)
src/notion.js     Notion: eventos, tareas asignadas y búsqueda (opcional)
src/queue.js      mensajes en espera cuando no queda cuota de IA
src/inbox.js      bandeja de tu web (opcional)
src/weekly.js     resumen semanal
src/mail.js       correo → avisos y tareas (opcional)
src/health.js     chequeo de salud y /salud
src/evening.js    cierre del día
src/social.js     asistente de X
public/           panel PWA
scripts/          moodle-token.mjs: saca el token de Moodle
schema.sql        esquema D1 (migrations/ para bases ya creadas)
```

## Límites de la capa gratuita (de sobra para uso personal)

| Recurso | Gratis | Uso típico |
|---|---|---|
| Workers | 100.000 peticiones/día | < 1.000 |
| D1 | 5 GB, 5 M lecturas/día | irrisorio |
| KV | 1 GB, 1.000 escrituras/día | años de fotos |
| Workers AI | 10.000 neuronas/día | ~20 mensajes del asistente/día sin Groq; con Groq, sin límite práctico |

## App y widget de macOS

App nativa con widget en [`macos-widget/`](../macos-widget/README.md): tareas pendientes en el escritorio, marcar
como hecha desde el widget, nota en Apple Notes y sincronización en las dos direcciones con Recordatorios (y así
con el iPhone). Entra con `DASH_TOKEN`.
