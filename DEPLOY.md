# Desplegar tu propia copia de Taskbot (aislada, cero datos compartidos)

Esto monta una instancia 100% tuya: tu propio bot de Telegram, tu propia base de
datos, tu propio dashboard. No comparte nada con ninguna otra instancia que
exista de este mismo código. **Coste: 0€**, capa gratuita de Cloudflare.

> **Si eres Claude Code y el humano te ha pedido "monta taskbot" o "sigue
> DEPLOY.md":** ejecuta los pasos en orden. Cada paso marcado con ⏸ requiere
> que el humano haga algo fuera de la terminal (hablar con un bot de Telegram,
> aprobar algo en el navegador, pegar un valor) — párate ahí, pide el dato o la
> confirmación, y no sigas hasta tenerlo.

## Antes de empezar (lo hace el humano)

1. Node.js instalado ([nodejs.org](https://nodejs.org), versión LTS).
2. Cuenta gratis en Cloudflare si no tienes una: https://dash.cloudflare.com/sign-up
   (no pide tarjeta).
3. Telegram instalado (móvil u ordenador).

Con eso listo, abre una terminal en esta carpeta y dile a Claude Code:
> "Sigue DEPLOY.md paso a paso para desplegar mi propia instancia"

## Pasos

### 1. Dependencias
```bash
npm install
```

### 2. Crear el bot de Telegram
⏸ **Manual, en la app de Telegram:**
1. Busca **@BotFather**, pulsa *Start*.
2. Escribe `/newbot`.
3. Dale un nombre (ej. "Mis Tareas") y un username acabado en `bot` (ej.
   `mistareas_bot`).
4. BotFather responde con un **token** (`123456789:AA...`). Pégaselo a Claude
   cuando lo pida.

### 3. Login en Cloudflare
```bash
npx wrangler login
```
⏸ Se abre el navegador — pulsa "Allow/Autorizar" ahí. Avisa a Claude cuando lo
hayas hecho.

### 4. Elegir un nombre único para tu instancia
Elige algo corto y tuyo, ej. `taskbot-alex`. Se usa para el Worker, la base de
datos y el KV, para que no choque con otras instancias de la misma cuenta.

### 5. Crear la base de datos
```bash
npx wrangler d1 create taskbot-TUNOMBRE
```
Copia el `database_id` que devuelve. Edita `wrangler.toml`:
- `name = "taskbot-TUNOMBRE"` (línea 2)
- en `[[d1_databases]]`: `database_name = "taskbot-TUNOMBRE"` y el nuevo
  `database_id`

### 6. Crear el almacén de archivos (KV)
```bash
npx wrangler kv namespace create FILES
```
Copia el `id` que devuelve y actualízalo en el bloque `[[kv_namespaces]]` de
`wrangler.toml`.

### 7. Aplicar el esquema
```bash
npx wrangler d1 execute taskbot-TUNOMBRE --remote --file=schema.sql
```

### 8. Secretos
⏸ Cada comando abre un prompt interactivo — el humano escribe el valor y pulsa
Enter. Lánzalos uno a uno y di en cada uno qué pegar:

```bash
npx wrangler secret put TELEGRAM_TOKEN
```
→ el token de BotFather (paso 2).

```bash
npx wrangler secret put TG_WEBHOOK_SECRET
```
→ una cadena aleatoria larga. Si el humano no quiere inventarla, genérala tú:
`node -e "console.log(crypto.randomUUID())"`.

```bash
npx wrangler secret put DASH_TOKEN
```
→ otra cadena aleatoria (será la contraseña del dashboard).

```bash
npx wrangler secret put CAL_TOKEN
```
→ otra cadena aleatoria distinta (para el feed de calendario `.ics`).

### 9. Desplegar
```bash
npx wrangler deploy
```
Imprime una URL tipo `https://taskbot-tunombre.SUCUENTA.workers.dev`. Guárdala.

### 10. Registrar el webhook de Telegram
Sustituye TOKEN (paso 2), URL (paso 9) y SECRETO (`TG_WEBHOOK_SECRET`, paso 8):
```bash
curl "https://api.telegram.org/botTOKEN/setWebhook?url=https://taskbot-tunombre.SUCUENTA.workers.dev/webhook&secret_token=SECRETO"
```
Debe responder `{"ok":true,...}`.

### 11. Activar el chat
⏸ El humano abre Telegram y le escribe cualquier cosa a su bot nuevo. El bot
responde con su chat id.

```bash
npx wrangler secret put OWNER_CHAT_ID
```
→ pega ese número.

Vuelve a escribirle algo: ahora ya guarda de verdad y responde con botones.

### 12. Instalar el dashboard en el móvil
⏸ El humano: abre la URL del paso 9 en Safari (iPhone) o Chrome (Android),
mete el `DASH_TOKEN` del paso 8, y en Safari: Compartir → Añadir a pantalla de
inicio.

### 13. (Opcional) Calendario
El humano puede suscribir esta URL en Ajustes → Calendario → Cuentas → Añadir
cuenta → Otra → Calendario suscrito:
```
https://taskbot-tunombre.SUCUENTA.workers.dev/calendar.ics?t=SU_CAL_TOKEN
```

## Verificación final (Claude, sin preguntar)
- `wrangler.toml` tiene `database_id`, KV `id` y `name` distintos a cualquier
  otra instancia que puedas ver en el repo/historial.
- `git status` no muestra ningún archivo con secretos reales (`.dev.vars` debe
  seguir ignorado).
- Resume al humano: URL del dashboard, y recuérdale guardar `DASH_TOKEN` en un
  gestor de contraseñas — no vive en ningún archivo del repo.
