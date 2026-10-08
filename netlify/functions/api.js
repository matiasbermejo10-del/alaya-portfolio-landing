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

const ESTADOS = ["Pendiente", "En curso", "Esperando respuesta", "Retomar en reunión", "Hecha", "Descartada"];
const CERRADOS = ["Hecha", "Descartada"];
// El estado manda, pero si alguien tildó o destildó "Done" desde Airtable se respeta eso.
function estado(f) {
  const s = ESTADOS.includes(f["Status"]) ? f["Status"] : "";
  const done = !!f["Done"];
  if (done) return CERRADOS.includes(s) ? s : "Hecha";
  return s && !CERRADOS.includes(s) ? s : "Pendiente";
}

const aTarea = (x) => ({
  id: x.id,
  task: x.fields["Task"] || "",
  companyId: (x.fields["Company"] || [])[0] || "",
  owner: x.fields["Owner"] || "",
  due: x.fields["Due Date"] || "",
  meetingDate: x.fields["Meeting Date"] || "",
  status: estado(x.fields),
});

// ---- Equipo (tabla "Team"): la lista fija de responsables ----
const plano = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
async function leerEquipo() {
  try {
    const rs = await listar("Team", ["Name"]);
    return rs.map((x) => String(x.fields["Name"] || "").trim()).filter(Boolean).sort((a, z) => a.localeCompare(z, "es"));
  } catch (e) {
    return null; // la tabla todavía no existe
  }
}
// "luis" o "Luis" -> "Luis Bermejo" si es el único Luis del equipo.
function canonico(nombre, equipo) {
  const n = plano(nombre);
  if (!n || !equipo) return String(nombre || "").trim();
  const exacto = equipo.find((p) => plano(p) === n);
  if (exacto) return exacto;
  const porNombre = equipo.filter((p) => plano(p).split(" ")[0] === n.split(" ")[0]);
  return porNombre.length === 1 ? porNombre[0] : String(nombre).trim();
}

const esId = (s) => typeof s === "string" && /^rec[A-Za-z0-9]{14}$/.test(s);
const esFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function campos(b) {
  const f = {};
  if ("task" in b) {
    const t = String(b.task || "").trim().slice(0, 2000);
    if (!t) throw new HttpError(400, "La tarea no puede quedar vacía");
    f["Task"] = t;
  }
  if ("status" in b) {
    if (!ESTADOS.includes(b.status)) throw new HttpError(400, "Estado inválido");
    f["Status"] = b.status;
    f["Done"] = CERRADOS.includes(b.status); // mantiene al día alertas e interfaces de Airtable
  }
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

// "Updated By" y "Status" son campos opcionales: si alguno no existe en la tabla, se guarda sin él.
async function guardar(metodo, ruta, fields, email) {
  const f = { ...fields, [AUDIT_FIELD]: email };
  for (const opcional of [null, AUDIT_FIELD, "Status"]) {
    if (opcional) delete f[opcional];
    try {
      return await airtable(ruta, { method: metodo, body: JSON.stringify({ fields: f, typecast: true }) });
    } catch (e) {
      if (e.tipo !== "UNKNOWN_FIELD_NAME") throw e;
    }
  }
  throw new HttpError(502, "Airtable: falta un campo en la tabla de tareas");
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
    if (accion === "meetings" && m === "GET") {
      // "Simple Summary" es opcional: si el campo no existe, se usa el resumen ejecutivo.
      const base = ["Title", "Meeting Date", "Attendees", "Executive Summary", "Status"];
      let rs;
      try { rs = await listar("Meeting Analysis", [...base, "Simple Summary"]); }
      catch (e) { if (e.tipo !== "UNKNOWN_FIELD_NAME") throw e; rs = await listar("Meeting Analysis", base); }
      const meetings = rs
        .filter((x) => x.fields["Status"] === "Procesado")
        .map((x) => ({
          id: x.id,
          title: x.fields["Title"] || "",
          date: x.fields["Meeting Date"] || "",
          attendees: x.fields["Attendees"] || "",
          summary: x.fields["Simple Summary"] || "",
          detail: x.fields["Simple Summary"] ? "" : x.fields["Executive Summary"] || "",
        }))
        .sort((a, z) => z.date.localeCompare(a.date));
      return json(200, { meetings });
    }
    if (accion === "meetings" && m === "POST") {
      // Carga un resumen de Granola: queda en "Nuevo" y el script de Railway lo analiza.
      let b = {};
      try { b = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Pedido inválido"); }
      const resumen = String(b.summary || "").trim();
      if (resumen.length < 50) throw new HttpError(400, "Pegá el resumen completo de Granola");
      if (resumen.length > 95000) throw new HttpError(400, "El resumen es demasiado largo");
      if (b.date && !esFecha(b.date)) throw new HttpError(400, "Fecha inválida");
      const f = { "Granola Summary": resumen, "Status": "Nuevo" };
      const titulo = String(b.title || "").trim().slice(0, 200);
      if (titulo) f["Title"] = titulo;
      if (b.date) f["Meeting Date"] = b.date;
      const r = await airtable(encodeURIComponent("Meeting Analysis"), { method: "POST", body: JSON.stringify({ fields: f, typecast: true }) });
      console.log(`${email} cargó la reunión ${r.id}`);
      return json(200, { ok: true });
    }
    if (accion === "team" && m === "POST") {
      let b = {};
      try { b = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Pedido inválido"); }
      const nombre = String(b.name || "").trim().replace(/\s+/g, " ");
      if (nombre.length < 2 || nombre.length > 60) throw new HttpError(400, "Escribí nombre y apellido");
      const equipo = await leerEquipo();
      if (!equipo) throw new HttpError(503, "Falta crear la tabla Team en Airtable");
      const existe = equipo.find((p) => plano(p) === plano(nombre));
      if (existe) return json(200, { name: existe });
      await airtable("Team", { method: "POST", body: JSON.stringify({ fields: { Name: nombre } }) });
      console.log(`${email} agregó a ${nombre} al equipo`);
      return json(200, { name: nombre });
    }
    if (accion !== "tasks") throw new HttpError(404, "No existe");
    const tabla = encodeURIComponent(TASKS);
    let b = {};
    if (m !== "GET") {
      try { b = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Pedido inválido"); }
    }
    if (m === "GET") {
      const base = ["Task", "Company", "Owner", "Due Date", "Meeting Date", "Done"];
      const [ts, cs, equipo] = await Promise.all([
        listar(TASKS, [...base, "Status"]).catch((e) => {
          if (e.tipo !== "UNKNOWN_FIELD_NAME") throw e;
          return listar(TASKS, base);
        }),
        listar("Portfolio", ["Name"]),
        leerEquipo(),
      ]);
      const tasks = ts.map(aTarea);
      tasks.forEach((t) => { t.owner = canonico(t.owner, equipo); });
      const companies = cs
        .map((c) => ({ id: c.id, name: c.fields["Name"] || "" }))
        .filter((c) => c.name)
        .sort((a, z) => a.name.localeCompare(z.name, "es"));
      return json(200, { tasks, companies, team: equipo });
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
