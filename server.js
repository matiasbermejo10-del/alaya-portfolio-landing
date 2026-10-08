// Servidor para correr la web fuera de Netlify (por ejemplo en Railway).
// Sirve la carpeta public/ y atiende /.netlify/functions/api con la misma función que usa Netlify.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handler } = require("./netlify/functions/api.js");

const PUBLICO = path.join(__dirname, "public");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const SEGURIDAD = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/.netlify/functions/api" || url.pathname === "/api") {
    let body = "";
    let demasiado = false;
    req.on("data", (d) => { body += d; if (body.length > 1500000 && !demasiado) { demasiado = true; res.writeHead(413, { ...SEGURIDAD, "Content-Type": "application/json" }); res.end('{"error":"El contenido es demasiado grande"}'); } });
    req.on("end", async () => {
      if (demasiado) return;
      const r = await handler({
        httpMethod: req.method, headers: req.headers, body,
        queryStringParameters: Object.fromEntries(url.searchParams),
      });
      res.writeHead(r.statusCode, { ...SEGURIDAD, ...r.headers });
      res.end(r.body);
    });
    return;
  }
  let archivo = path.normalize(path.join(PUBLICO, decodeURIComponent(url.pathname)));
  if (!archivo.startsWith(PUBLICO)) { res.writeHead(403); return res.end(); }
  if (url.pathname.endsWith("/")) archivo = path.join(archivo, "index.html");
  fs.readFile(archivo, (err, datos) => {
    if (err) { res.writeHead(404, SEGURIDAD); return res.end("No encontrado"); }
    res.writeHead(200, { ...SEGURIDAD, "Content-Type": TIPOS[path.extname(archivo)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(datos);
  });
}).listen(process.env.PORT || 3000, () => console.log("Portfolio 360 en el puerto", process.env.PORT || 3000));
