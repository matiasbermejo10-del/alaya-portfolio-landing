// API de Portfolio 360: valida el login de Google (solo el dominio permitido)
// y lee/escribe la tabla "Tasks" de Airtable. El token de Airtable vive
// solo acá (variables de entorno del servidor), nunca llega al navegador.
const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const DOMAIN = (process.env.ALLOWED_DOMAIN || "alaya.capital").toLowerCase();
const TASKS = "Tasks";
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
  let r;
  try {
    r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw new HttpError(503, "No se pudo verificar la sesión con Google, probá de nuevo");
  }
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

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Airtable permite 5 pedidos por segundo por base: ante 429, error de red o caída se reintenta con pausa.
async function airtable(path, opts = {}) {
  let ultimo;
  for (let intento = 0; intento < 4; intento++) {
    if (intento) await espera(600 * 2 ** intento);
    let r;
    try {
      r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
        ...opts,
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      ultimo = new HttpError(503, "No se pudo conectar con Airtable, probá de nuevo");
      continue;
    }
    const texto = await r.text();
    let data = {};
    try { data = JSON.parse(texto); } catch (e) { /* respuesta no JSON */ }
    if (r.ok) return data;
    const err = new HttpError(r.status === 429 ? 503 : 502,
      r.status === 429 ? "Airtable está saturado, probá en unos segundos" : "Airtable: " + ((data.error && (data.error.message || data.error.type)) || r.status));
    err.tipo = data.error && data.error.type;
    const msg = (data.error && data.error.message) || "";
    const m = /Unknown field name: "([^"]+)"/.exec(msg);
    if (m) err.campo = m[1];
    if (r.status !== 429 && r.status < 500) throw err; // error de datos: no tiene sentido reintentar
    ultimo = err;
  }
  throw ultimo;
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

const ESTADOS = ["To do", "In progress", "Catch Up", "Stand by", "Done"];
const PRIORIDADES = ["Urgent", "High", "Medium", "Low", "Stand by"];
// El estado manda; si alguien tildó "Done" desde Airtable sin cambiar el estado, también cuenta como terminada.
function estado(f) {
  const s = ESTADOS.includes(f["Status"]) ? f["Status"] : "To do";
  if (f["Done"]) return "Done";
  return s;
}

const CAMPOS_TAREA = ["Name", "Owner", "Status", "Priority", "Start Date", "Deadline", "Project", "Company",
  "Meeting", "Meeting Date", "Notes", "Next step", "URL", "Minuta de reunión", "Attachments", "Done", "Source", "Reviewed"];
const aTarea = (x) => {
  const f = x.fields;
  return {
    id: x.id,
    task: f["Name"] || "",
    owner: f["Owner"] || "",
    status: estado(f),
    priority: PRIORIDADES.includes(f["Priority"]) ? f["Priority"] : "",
    start: f["Start Date"] || "",
    due: f["Deadline"] || "",
    projectId: (f["Project"] || [])[0] || "",
    companyId: (f["Company"] || [])[0] || "",
    meetingDate: f["Meeting Date"] || "",
    notes: f["Notes"] || "",
    next: f["Next step"] || "",
    url: f["URL"] || "",
    minuta: f["Minuta de reunión"] || "",
    attachments: (f["Attachments"] || []).map((a) => ({ url: a.url, name: a.filename || "archivo" })),
    source: f["Source"] || "",
    reviewed: !!f["Reviewed"],
  };
};

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

const esLink = (s) => typeof s === "string" && /^https?:\/\/\S+$/i.test(s.trim());
function campos(b) {
  const f = {};
  if ("task" in b) {
    const t = String(b.task || "").trim().slice(0, 2000);
    if (!t) throw new HttpError(400, "La tarea no puede quedar vacía");
    f["Name"] = t;
  }
  if ("status" in b) {
    if (!ESTADOS.includes(b.status)) throw new HttpError(400, "Estado inválido");
    f["Status"] = b.status;
    f["Done"] = b.status === "Done"; // mantiene al día alertas e interfaces de Airtable
  }
  if ("priority" in b) {
    if (b.priority && !PRIORIDADES.includes(b.priority)) throw new HttpError(400, "Prioridad inválida");
    f["Priority"] = b.priority || null;
  }
  if ("owner" in b) f["Owner"] = String(b.owner || "").trim().slice(0, 120);
  for (const [k, campo] of [["due", "Deadline"], ["start", "Start Date"]]) {
    if (!(k in b)) continue;
    if (b[k] && !esFecha(b[k])) throw new HttpError(400, "Fecha inválida");
    f[campo] = b[k] || null;
  }
  for (const [k, campo, nombre] of [["companyId", "Company", "Empresa"], ["projectId", "Project", "Proyecto"]]) {
    if (!(k in b)) continue;
    if (b[k] && !esId(b[k])) throw new HttpError(400, nombre + " inválida");
    f[campo] = b[k] ? [b[k]] : [];
  }
  if ("notes" in b) f["Notes"] = String(b.notes || "").slice(0, 20000);
  if ("reviewed" in b) f["Reviewed"] = !!b.reviewed;
  if ("next" in b) f["Next step"] = String(b.next || "").trim().slice(0, 500);
  for (const [k, campo] of [["url", "URL"], ["minuta", "Minuta de reunión"]]) {
    if (!(k in b)) continue;
    const v = String(b[k] || "").trim();
    if (v && !esLink(v)) throw new HttpError(400, "El link tiene que empezar con http");
    f[campo] = v || null;
  }
  return f;
}

// Algunos campos son opcionales: si la tabla no los tiene, se guarda sin ellos. Si falta otro, se avisa cuál.
const OPCIONALES = new Set([AUDIT_FIELD, "Status", "Source", "Priority", "Start Date", "Next step", "URL", "Minuta de reunión", "Notes", "Project"]);
async function guardar(metodo, ruta, fields, email) {
  const f = { ...fields, [AUDIT_FIELD]: email };
  for (let i = 0; i < OPCIONALES.size + 1; i++) {
    try {
      return await airtable(ruta, { method: metodo, body: JSON.stringify({ fields: f, typecast: true }) });
    } catch (e) {
      if (e.tipo !== "UNKNOWN_FIELD_NAME" || !e.campo || !OPCIONALES.has(e.campo) || !(e.campo in f)) {
        if (e.tipo === "UNKNOWN_FIELD_NAME") throw new HttpError(502, `Falta el campo "${e.campo || "?"}" en la tabla Tasks de Airtable`);
        throw e;
      }
      console.warn(`La tabla no tiene el campo "${e.campo}"; se guarda sin él`);
      delete f[e.campo];
    }
  }
  throw new HttpError(502, "No se pudo guardar en Airtable");
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
      const base = ["Title", "Meeting Date", "Attendees", "Executive Summary", "Status", "Error Detail"];
      let rs;
      try { rs = await listar("Meeting Analysis", [...base, "Simple Summary"]); }
      catch (e) { if (e.tipo !== "UNKNOWN_FIELD_NAME") throw e; rs = await listar("Meeting Analysis", base); }
      const meetings = rs
        .map((x) => ({
          id: x.id,
          status: x.fields["Status"] || "Nuevo",
          error: x.fields["Status"] === "Error" ? String(x.fields["Error Detail"] || "").slice(0, 300) : "",
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
    if (accion === "news" && m === "GET") {
      const [ns, cs] = await Promise.all([
        listar("News", ["Date", "Company", "Level", "Summary", "Source", "Link", "Mentions Alaya"]),
        listar("Portfolio", ["Name"]),
      ]);
      const nombre = Object.fromEntries(cs.map((c) => [c.id, c.fields["Name"] || ""]));
      const news = ns.map((x) => ({
        id: x.id,
        date: x.fields["Date"] || "",
        companyId: (x.fields["Company"] || [])[0] || "",
        company: nombre[(x.fields["Company"] || [])[0]] || "",
        level: String(x.fields["Level"] || ""),
        summary: x.fields["Summary"] || "",
        source: x.fields["Source"] || "",
        link: x.fields["Link"] || "",
        alaya: !!x.fields["Mentions Alaya"],
      })).sort((a, z) => z.date.localeCompare(a.date));
      return json(200, { news });
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
    if (accion === "projects" && m === "POST") {
      let b = {};
      try { b = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Pedido inválido"); }
      const nombre = String(b.name || "").trim().replace(/\s+/g, " ");
      if (nombre.length < 2 || nombre.length > 100) throw new HttpError(400, "Escribí el nombre del proyecto");
      const ps = await listar("Projects", ["Name", "Status"]);
      const existe = ps.find((p) => plano(p.fields["Name"]) === plano(nombre));
      if (existe) return json(200, { project: { id: existe.id, name: existe.fields["Name"], done: existe.fields["Status"] === "Completed" } });
      const r = await airtable("Projects", { method: "POST", body: JSON.stringify({ fields: { Name: nombre, Status: "To do" }, typecast: true }) });
      console.log(`${email} creó el proyecto ${nombre}`);
      return json(200, { project: { id: r.id, name: nombre, done: false } });
    }
    if (accion !== "tasks") throw new HttpError(404, "No existe");
    const tabla = encodeURIComponent(TASKS);
    let b = {};
    if (m !== "GET") {
      try { b = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Pedido inválido"); }
    }
    if (m === "GET") {
      const [ts, cs, ps, equipo] = await Promise.all([
        listar(TASKS, CAMPOS_TAREA).catch((e) => {
          if (e.tipo === "UNKNOWN_FIELD_NAME" && e.campo === "Reviewed") return listar(TASKS, CAMPOS_TAREA.filter((c) => c !== "Reviewed"));
          throw e;
        }),
        listar("Portfolio", ["Name"]),
        listar("Projects", ["Name", "Status"]),
        leerEquipo(),
      ]);
      const projects = ps
        .map((p) => ({ id: p.id, name: p.fields["Name"] || "", done: p.fields["Status"] === "Completed" }))
        .filter((p) => p.name)
        .sort((a, z) => (a.done - z.done) || a.name.localeCompare(z.name, "es"));
      const tasks = ts.map(aTarea);
      tasks.forEach((t) => { t.owner = canonico(t.owner, equipo); });
      const companies = cs
        .map((c) => ({ id: c.id, name: c.fields["Name"] || "" }))
        .filter((c) => c.name)
        .sort((a, z) => a.name.localeCompare(z.name, "es"));
      return json(200, { tasks, companies, projects, team: equipo });
    }
    if (m === "POST") {
      const f = { Status: "To do", Source: "Manual", ...campos(b) };
      if (!f["Name"]) throw new HttpError(400, "Escribí la tarea");
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
