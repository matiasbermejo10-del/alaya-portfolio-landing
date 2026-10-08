# Alaya Portfolio 360

Web interna de Alaya Capital: dashboards de Airtable incrustados, reuniones y gestión de tareas.

- `public/index.html`: la web. Para sumar un dashboard, agregá una línea en `SECCIONES` con el código `shr…` del link público de Airtable.
- `netlify/functions/api.js`: valida el login de Google (solo `@alaya.capital`) y lee/escribe las tablas **Tasks**, **Projects**, **Team** y **Meeting Analysis** de Airtable.
- `server.js`: servidor Node que sirve la web y la API (es lo que corre en Railway). Railway publica solo cada push a `main`.

## Variables de entorno (Railway → servicio → Variables)

| Variable | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth (tipo "Aplicación web") de Google Cloud |
| `AIRTABLE_TOKEN` | Token de Airtable con `data.records:read` y `data.records:write` sobre la base |
| `AIRTABLE_BASE_ID` | `appSArF5SM32ZNUMk` |

Si se cambia el dominio de la web, hay que agregarlo en Google Cloud → Credenciales → ID de cliente → "Orígenes autorizados de JavaScript".
