// API de Portfolio 360: valida el login de Google (solo el dominio permitido)
// y lee/escribe la tabla "Meeting Tasks" de Airtable. El token de Airtable vive
// solo acá (variables de entorno de Netlify), nunca llega al navegador.
const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const DOMAIN = (process.env.ALLOWED_DOMAIN || "alaya.capital").toLowerCase();
const TASKS = "Meeting Tasks";
const AUDIT_FIELD = "Updated By";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sesiones = new Map(); // token -> { email, exp }
async function usuario(event) {
  const h = event.headers.authorization || event.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw new HttpError(401, "Falta iniciar sesión");
  const ahora = Date.now() / 1000;
  const c = sesiones.get(token);
  if (c && c.exp > ahora) return c.email;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token));
  if (!r.ok) throw new HttpError(401, "Sesión vencida");
  const t = await r.json();
  if (t.aud !== CLIENT_ID || Number(t.exp) <= ahora) throw new HttpError(401, "Sesión vencida");
  const email = String(t.email || "").toLowerCase();
  const verificado = t.email_verified === true || t.email_verified === "true";
  if (!verificado || String(t.hd || "").toLowerCase() !== DOMAIN || !email.endsWith("@" + DOMAIN))
    throw new HttpError(403, "Solo cuentas @" + DOMAIN);
  if (sesiones.size > 500) sesiones.clear();
  sesiones.set(token, { email, exp: Number(t.exp) });
  return email;
}

async function airtable(path, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...opts,
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
  });
  const texto = await r.text();
  let data = {};
  try { data = JSON.parse(texto); } catch (e) { /* respuesta no JSON */ }
  if (!r.ok) {
    const err = new HttpError(502, "Airtable: " + ((data.error && (data.error.message || data.error.type)) || r.status));
    err.tipo = data.error && data.error.type;
    throw err;
  }
  return data;
}

async function listar(tabla, campos) {
  const out = [];
  let offset;
  do {
    const p = new URLSearchParams();
    campos.forEach((c) => p.append("fields[]", c));
    if (offset) p.set("offset", offset);
    const j = await airtable(`${encodeURIComponent(tabla)}?${p}`);
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

const aTarea = (x) => ({
  id: x.id,
  task: x.fields["Task"] || "",
  companyId: (x.fields["Company"] || [])[0] || "",
  owner: x.fields["Owner"] || "",
  due: x.fields["Due Date"] || "",
  meetingDate: x.fields["Meeting Date"] || "",
  done: !!x.fields["Done"],
});

const esId = (s) => typeof s === "string" && /^rec[A-Za-z0-9]{14}$/.test(s);
const esFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function campos(b) {
  const f = {};
  if ("task" in b) {
    const t = String(b.task || "").trim().slice(0, 2000);
    if (!t) throw new HttpError(400, "La tarea no puede quedar vacía");
    f["Task"] = t;
  }
  if ("done" in b) f["Done"] = !!b.done;
  if ("owner" in b) f["Owner"] = String(b.owner || "").trim().slice(0, 120);
  if ("due" in b) {
    if (b.due && !esFecha(b.due)) throw new HttpError(400, "Fecha inválida");
    f["Due Date"] = b.due || null;
  }
  if ("companyId" in b) {
    if (b.companyId && !esId(b.companyId)) throw new HttpError(400, "Empresa inválida");
    f["Company"] = b.companyId ? [b.companyId] : [];
  }
  return f;
}

// Guarda quién hizo el cambio si la tabla tiene el campo "Updated By"; si no, guarda igual.
async function guardar(metodo, ruta, fields, email) {
  const cuerpo = (f) => JSON.stringify({ fields: f, typecast: true });
  try {
    return await airtable(ruta, { method: metodo, body: cuerpo({ ...fields, [AUDIT_FIELD]: email }) });
  } catch (e) {
    if (e.tipo !== "UNKNOWN_FIELD_NAME") throw e;
    return airtable(ruta, { method: metodo, body: cuerpo(fields) });
  }
}

exports.handler = async (event) => {
  try {
    const accion = (event.queryStringParameters || {}).action || "";
    const m = event.httpMethod;
    if (accion === "config")
      return json(200, { clientId: CLIENT_ID || "", domain: DOMAIN, listo: !!(CLIENT_ID && TOKEN && BASE) });
    if (!CLIENT_ID || !TOKEN || !BASE) throw new HttpError(503, "Falta configurar el sitio");
    const email = await usuario(event);
    if (accion === "me") return json(200, { email });
    if (accion !== "tasks") throw new HttpError(404, "No existe");
    const tabla = encodeURIComponent(TASKS);
    let b = {};
    if (m !== "GET") {
      try { b = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Pedido inválido"); }
    }
    if (m === "GET") {
      const [ts, cs] = await Promise.all([
        listar(TASKS, ["Task", "Company", "Owner", "Due Date", "Meeting Date", "Done"]),
        listar("Portfolio", ["Name"]),
      ]);
      const companies = cs
        .map((c) => ({ id: c.id, name: c.fields["Name"] || "" }))
        .filter((c) => c.name)
        .sort((a, z) => a.name.localeCompare(z.name, "es"));
      return json(200, { tasks: ts.map(aTarea), companies });
    }
    if (m === "POST") {
      const f = campos(b);
      if (!f["Task"]) throw new HttpError(400, "Escribí la tarea");
      const r = await guardar("POST", tabla, f, email);
      console.log(`${email} creó ${r.id}`);
      return json(200, { task: aTarea(r) });
    }
    if (!esId(b.id)) throw new HttpError(400, "Tarea inválida");
    if (m === "PATCH") {
      const f = campos(b);
      if (!Object.keys(f).length) throw new HttpError(400, "Nada para cambiar");
      const r = await guardar("PATCH", `${tabla}/${b.id}`, f, email);
      console.log(`${email} editó ${b.id}: ${Object.keys(f).join(", ")}`);
      return json(200, { task: aTarea(r) });
    }
    if (m === "DELETE") {
      await airtable(`${tabla}/${b.id}`, { method: "DELETE" });
      console.log(`${email} borró ${b.id}`);
      return json(200, { ok: true });
    }
    throw new HttpError(405, "Método no permitido");
  } catch (e) {
    if (!e.status) console.error(e);
    return json(e.status || 500, { error: e.status ? e.message : "Error interno" });
  }
};
