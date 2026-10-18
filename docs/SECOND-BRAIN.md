# Second brain: implementación y operación

Se conserva el bot, su panel, los feeds y la configuración personal. La ampliación añade herramientas compartidas, un puente saliente a Markdown y un servicio de llamadas. OpenJarvis se evalúa aparte; no registra otro webhook ni mantiene otra agenda.

## Piezas

- `src/personal-tools.js`: búsqueda amplia de tareas, Obsidian, memoria, Gmail y estado de fuentes.
- `src/runtime.js`: cola D1, autenticación independiente, leases y confirmaciones del servicio personal.
- `runtime/`: servicio de usuario con Markdown, memoria y cuenta Telegram Jarvis.
- `src/calendar-bridge.js`: tiempo ocupado de iCloud/Google a través del Worker de reservas existente. No duplica sus credenciales.
- `/internal/busy`: agenda interna para el servicio de reservas, sin volver a consultar el calendario externo y sin crear un bucle.
- `src/proactive.js`: llamadas por plazos con hora exacta, desactivadas hasta que se acuerden silencio y antelación.
- `src/freshness.js`: última ejecución y último éxito por sincronizador.

## Puesta en marcha

1. Copia recuperable de D1, configuración y versiones de Workers.
2. Aplicar `migrations/2026-10-18-second-brain.sql`. Solo crea tablas e índices adicionales.
3. Actualizar el Worker `api` con `BookingCoordinator` y su migración SQLite. Su configuración mantiene días, franjas, duraciones y márgenes actuales.
4. Actualizar Taskbot con el binding `CALENDAR_API` al Worker `api`.
5. Configurar `RUNTIME_TOKEN`, distinto de tokens de panel, feeds y llamadas legacy. No ponerlo en Git.
6. Preparar `~/.config/taskbot/runtime.json` desde `runtime/config.example.json` y `~/.config/taskbot/runtime.env` con permisos 0600.
7. En el archivo privado: `RUNTIME_TOKEN`; para llamadas también `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` creada expresamente para este Mac con `runtime/authorize_telegram.py`. Nunca reutilizar una sesión de Modal u otro equipo: Telegram puede revocar la clave por uso simultáneo desde IP distintas.
8. `python3 runtime/install.py --start` instala copia estable en `~/.local/share/taskbot` y LaunchAgent `com.taskbot.runtime`. No realiza una llamada por sí mismo.
9. Activar `config.runtime.enabled`; activar `voice` únicamente cuando el servicio de cuenta esté preparado. No mantener simultáneamente dos propietarios del transporte de llamadas.
10. Comprobar `servicio_estado` y `/salud`. Una llamada real requiere que el usuario esté disponible; no sustituirla por una prueba de importación.

El servicio no abre un servidor local a Internet: consulta trabajos por HTTPS. El token y las sesiones no están en el plist. `write_paths` empieza limitado a `_Jarvis`; ampliar secciones de proyecto es una decisión explícita.

El Mac tiene configurado un relay HTTPS autenticado en Modal para cuando no alcanza directamente el Worker. Solo admite rutas concretas del runtime y el mismo token independiente. No usa GPU; consume los créditos o cuota de Modal y no garantiza coste cero. El servicio intenta primero la conexión directa y no repite una escritura de resultado incierto. La presencia se guarda en D1 para evitar una escritura KV por latido.

## Operación

- Estado: `launchctl print gui/$(id -u)/com.taskbot.runtime`.
- Logs: `~/.local/share/taskbot/logs/`. No incluyen contenido de notas ni audio deliberadamente.
- Parar: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.taskbot.runtime.plist`.
- Arrancar: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.taskbot.runtime.plist`.
- Si actualizas `runtime/`, repetir instalación y reinicio para renovar la copia estable.
- Si el Mac duerme o no tiene red, las herramientas locales lo indican. No se promete disponibilidad permanente por instalar un LaunchAgent.

Una ejecución pendiente puede haber escrito ya. `servicio_estado` acepta el ID de trabajo: consultar antes de repetir una captura. Los trabajos tienen lease y plazo; el servicio conserva resultados por identidad para devolverlos tras un reintento.

Las escrituras de Markdown requieren una versión SHA-256 y conservan la versión previa en `~/.local/share/taskbot/backups`. No se indexan esos backups. `memoria_olvidar` retira la memoria de la recuperación ordinaria; la copia técnica de recuperación no se inyecta como memoria.

## Calendario y reservas

Se mantienen los feeds .ics, los UID del dominio actual y la agenda de la web. Apple Calendar sigue mostrando los calendarios suscritos de solo lectura: no se ha convertido un feed en calendario editable por instalar el puente.

Las reservas recibidas por `inbox` bloquean el planificador. El Worker de reservas consulta también la agenda interna; el planificador consulta la ocupación externa. Las llamadas entre servicios distinguen esas direcciones para no volver a entrar en el mismo cálculo.

`BookingCoordinator` serializa solicitudes de un propietario; la identidad estable de Google recupera un evento si se pierde la respuesta. La confirmación se persiste antes de las notificaciones. Los fallos de copia al panel se reintentan. El coordinador conserva una copia mínima sin email y la limpia después de la reunión; la política de privacidad de la web debe reflejarlo.

El frontend de la web conserva una identidad por intento mientras permanezca abierto el formulario. Una respuesta perdida no debe provocar una segunda invitación.

## Gmail: dos cuentas separadas

Se ha elegido conectar ambas, empezando por Gmail personal. Las herramientas buscan, leen hilos, organizan y crean borradores; no tienen un endpoint de envío ni borrado.

En la configuración desplegada se usa `gmail.broker=true`: el Worker de reservas conserva su cliente OAuth existente y guarda cada autorización de Gmail por separado. Ejecutar `node scripts/gmail-connect.mjs --account personal` y después `--account universidad`. Se abre Google en el navegador y el callback local escucha únicamente en 127.0.0.1:8765. Hace falta consentimiento y Gmail API habilitada; no se solicita ni se imprime el secreto del cliente.

La configuración directa es una alternativa: primera cuenta `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`.
Segunda cuenta Google Workspace: `UNIVERSITY_GMAIL_CLIENT_ID`, `UNIVERSITY_GMAIL_CLIENT_SECRET`, `UNIVERSITY_GMAIL_REFRESH_TOKEN`.
Si el proveedor universitario no es Gmail/Workspace, hay que añadir su adaptador específico; no reutilizar credenciales de otra cuenta suponiendo que sirve.

`scripts/gmail-auth.mjs` obtiene autorización con consentimiento de Google y escribe un archivo privado 0600. Requiere un cliente OAuth válido, Gmail API habilitada y redirect compatible. No imprime el refresh token. La cuenta se elige durante el consentimiento; los tokens se configuran después como secretos del Worker.

Si hay dos cuentas conectadas, buscar sin cuenta consulta ambas. Para leer/organizar/preparar borrador hay que identificar la cuenta; no se decide únicamente por un ID que podría existir en otro buzón.

## Proactividad

El despertador existente conserva su configuración. Las nuevas llamadas urgentes no se activan por defecto. El usuario ha decidido definir sus reglas más adelante.

`avisos_configurar` permite acordar silencio desde/hasta y antelación para plazos pendientes con hora exacta. Solo entonces puede activarse. No incluye una categoría genérica de “cualquier cosa importante” que el modelo pueda inventar.

## OpenJarvis

La evaluación usa Python 3.10–3.13 y la versión fijada en `runtime/requirements-evaluation.txt`. La versión revisada no admite Python 3.14; esto no obliga a cambiar el Python del servicio de voz.

`runtime/evaluate.py --scripted --output informe.json` prueba compatibilidad del adaptador con 30 peticiones por cada bucle. Las herramientas devuelven datos ficticios y nunca escriben en tus servicios. Un resultado perfecto en ese modo NO mide inteligencia ni justifica migrar el agente.

`--worker URL` usa el mismo gateway de modelos y herramientas sintéticas para ambos bucles. Requiere `RUNTIME_TOKEN` y `config.runtime.evaluation=true`, solo durante la evaluación. El informe separa errores, modelo, tiempos y selección esperada de herramienta. No mide audio ni conectores reales; se revisan también las respuestas, no solo la coincidencia de nombre de herramienta.

Mientras no exista una mejora demostrada, el agente de Taskbot sigue siendo el único activo. OpenJarvis no se convierte en dependencia obligatoria del asistente por aprobar una prueba de contratos.

## Verificación

- `npm test`: integración D1/SQLite, cambios de tareas, sincronización, horas y reglas.
- `npm run test:runtime`: rutas, exclusiones, reintentos, memoria y conflictos de archivos.
- `python3 -m compileall -q runtime jarvis`.
- `npx wrangler deploy --dry-run` y pruebas del Worker local.
- En `api/`, `npm test`: recurrencias, DST, concurrencia, reintentos y fallos de proveedores.

## Recuperación

Desactivar `runtime.voice` permite volver a despachar al flujo legacy de Modal/GitHub, pero antes hay que comprobar que su autorización de Telegram siga siendo válida y parar el transporte nuevo. La sesión antigua fue rechazada al intentar compartirla; no es un rollback operativo garantizado sin volver a autorizar. `runtime.enabled=false` desactiva nuevas operaciones locales.

Volver a una versión de Worker no debe restaurar una copia antigua de D1 sobre reservas nuevas. La migración es aditiva y puede permanecer al volver al código anterior. La API de reservas debe conservar un coordinador equivalente antes de retirar su namespace.

Los datos, la configuración personal y las autorizaciones permanecen fuera del repo público. La rama de implementación se mantiene separada de la versión anterior para revisar los cambios antes de integrar el código fuente principal.
