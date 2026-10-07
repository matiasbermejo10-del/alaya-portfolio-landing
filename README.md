# Alaya Portfolio 360

Web interna de Alaya Capital: dashboards de Airtable incrustados + gestión de tareas.

- `public/index.html`: la web. Para sumar un dashboard, agregá una línea en `SECCIONES` con el código `shr…` del link público de Airtable.
- `netlify/functions/api.js`: valida el login de Google (solo `@alaya.capital`) y lee/escribe la tabla **Meeting Tasks** de Airtable.

Netlify publica solo cada push a `main`.

## Variables de entorno (Netlify → Project configuration → Environment variables)

| Variable | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth (tipo "Aplicación web") de Google Cloud |
| `AIRTABLE_TOKEN` | Token de Airtable con `data.records:read` y `data.records:write` sobre la base |
| `AIRTABLE_BASE_ID` | `appSArF5SM32ZNUMk` |

Si la tabla Meeting Tasks tiene un campo de texto **Updated By**, ahí queda el mail de quien hizo el último cambio.
