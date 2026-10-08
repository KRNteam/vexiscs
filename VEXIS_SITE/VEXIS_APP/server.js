const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "content.json");
const ASSETS_DIR = path.join(ROOT, "assets");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.RENDER_SERVICE_ID ? "0.0.0.0" : "127.0.0.1";
const MAX_JSON_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SESSION_COOKIE = "vexis_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PASSWORD_SALT = randomBytes(16);
const ADMIN_PASSWORD_HASH = typeof ADMIN_PASSWORD === "string" && ADMIN_PASSWORD.length >= 12
  ? scryptSync(ADMIN_PASSWORD, PASSWORD_SALT, 64)
  : null;
const sessions = new Map();
const failedLogins = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function getSession(request) {
  const cookieHeader = request.headers.cookie || "";
  const token = cookieHeader.split(";").map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function setSessionCookie(response, token, maxAge) {
  const secure = HOST === "0.0.0.0" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || !request.headers.host) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host !== request.headers.host) return false;
    const fetchSite = request.headers["sec-fetch-site"];
    return !fetchSite || fetchSite === "same-origin";
  } catch {
    return false;
  }
}

function loginBlocked(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const failure = failedLogins.get(ip);
  if (!failure) return false;
  if (failure.blockedUntil && failure.blockedUntil > Date.now()) return true;
  if (failure.blockedUntil) failedLogins.delete(ip);
  return false;
}

function recordFailedLogin(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const failure = failedLogins.get(ip) || { count: 0, blockedUntil: 0 };
  failure.count += 1;
  if (failure.count >= 5) {
    failure.count = 0;
    failure.blockedUntil = Date.now() + 15 * 60 * 1000;
  }
  failedLogins.set(ip, failure);
}

async function readJson(request, limit = MAX_JSON_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Файл слишком большой.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Не удалось прочитать данные. Проверьте форму и повторите попытку.");
    error.statusCode = 400;
    throw error;
  }
}

function normalizeContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Получены данные сайта неверного формата.");
  }
  const result = {};
  for (const collection of ["players", "news", "matches", "tournaments", "shop"]) {
    if (!Array.isArray(input[collection])) {
      throw new Error(`Список «${collection}» имеет неверный формат.`);
    }
    result[collection] = input[collection].map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`В списке «${collection}» найдена некорректная запись.`);
      }
      for (const [key, value] of Object.entries(entry)) {
        if (typeof value === "string" && value.length > 10000) {
          throw new Error("Одно из полей слишком длинное.");
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          throw new Error("Вложенные объекты в записи не поддерживаются.");
        }
      }
      if (collection === "matches" && entry.maps !== undefined) {
        if (!Array.isArray(entry.maps) || entry.maps.length > 3) {
          throw new Error("У матча можно указать не больше трёх карт.");
        }
        for (const map of entry.maps) {
          if (!map || typeof map !== "object" || Array.isArray(map)) {
            throw new Error("Данные карты имеют неверный формат.");
          }
          if (typeof map.name !== "string" || map.name.length > 100 ||
              (map.score !== undefined && (typeof map.score !== "string" || map.score.length > 100))) {
            throw new Error("Название карты или её счёт имеют неверный формат.");
          }
          if (map.image && ![
            "assets/cs-map-screenshot-1.jpg",
            "assets/cs-map-screenshot-2.jpg",
            "assets/cs-map-nuke.jpg",
            "assets/cs-map-anubis.jpg",
            "assets/cs-map-ancient.jpg",
            "assets/cs-map-inferno.jpg",
            "assets/cs-map-train.jpg",
            "assets/cs-map-overpass.jpg"
          ].includes(map.image)) {
            throw new Error("Для карт можно выбирать только изображения из списка.");
          }
        }
      }
      if (typeof entry.id !== "string" || !entry.id || entry.id.length > 100) {
        throw new Error("У каждой записи должен быть уникальный идентификатор.");
      }
      return entry;
    });
    const ids = result[collection].map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`В списке «${collection}» повторяются идентификаторы.`);
    }
  }
  return result;
}

async function serveFile(request, response, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (!relativePath || relativePath.includes("\0")) {
    response.writeHead(400).end("Bad request");
    return;
  }
  const resolved = path.resolve(ROOT, relativePath);
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = await fs.readFile(resolved);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": path.basename(resolved) === "content.json" ? "no-store" : "no-cache"
    });
    if (request.method === "HEAD") response.end();
    else response.end(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Файл не найден.");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/favicon.ico") {
      response.writeHead(302, { Location: "/assets/vexis-logo.png", "Cache-Control": "public, max-age=86400" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { app: "vexis-team", root: ROOT, adminConfigured: Boolean(ADMIN_PASSWORD_HASH) });
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/") && !checkSameOrigin(request)) {
      sendJson(response, 403, { error: "Запросы разрешены только с этого сайта." });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!ADMIN_PASSWORD_HASH) {
        sendJson(response, 503, { error: "Вход отключён: задайте ADMIN_PASSWORD длиной не менее 12 символов." });
        return;
      }
      if (loginBlocked(request)) {
        sendJson(response, 429, { error: "Слишком много попыток входа. Попробуйте через 15 минут." });
        return;
      }
      const input = await readJson(request, 2048);
      const password = typeof input.password === "string" ? input.password : "";
      const suppliedHash = scryptSync(password, PASSWORD_SALT, 64);
      if (!timingSafeEqual(suppliedHash, ADMIN_PASSWORD_HASH)) {
        recordFailedLogin(request);
        sendJson(response, 401, { error: "Неверный пароль." });
        return;
      }
      failedLogins.delete(request.socket.remoteAddress || "unknown");
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      setSessionCookie(response, token, SESSION_TTL_SECONDS);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      const token = getSession(request);
      if (token) sessions.delete(token);
      setSessionCookie(response, "", 0);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth") {
      sendJson(response, 200, { authenticated: Boolean(getSession(request)) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/content") {
      const content = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
      sendJson(response, 200, content);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/content") {
      if (!getSession(request)) {
        sendJson(response, 401, { error: "Войдите в панель управления." });
        return;
      }
      const input = await readJson(request);
      let content;
      try {
        content = normalizeContent(input);
      } catch (error) {
        if (!error.statusCode) error.statusCode = 400;
        throw error;
      }
      const temporaryFile = `${DATA_FILE}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryFile, `${JSON.stringify(content, null, 2)}\n`, "utf8");
      await fs.rename(temporaryFile, DATA_FILE);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      if (!getSession(request)) {
        sendJson(response, 401, { error: "Войдите в панель управления." });
        return;
      }
      const input = await readJson(request, MAX_IMAGE_BYTES + 1024 * 1024);
      const supportedTypes = {
        "image/png": { extension: ".png", signature: (data) => data.length > 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
        "image/jpeg": { extension: ".jpg", signature: (data) => data.length > 3 && data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217 },
        "image/webp": { extension: ".webp", signature: (data) => data.length > 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" }
      };
      const type = supportedTypes[input.type];
      if (!type || typeof input.data !== "string") {
        sendJson(response, 400, { error: "Выберите изображение PNG, JPG или WebP." });
        return;
      }
      const image = Buffer.from(input.data, "base64");
      if (image.length > MAX_IMAGE_BYTES) {
        sendJson(response, 413, { error: "Размер фотографии не должен превышать 5 МБ." });
        return;
      }
      if (!type.signature(image)) {
        sendJson(response, 400, { error: "Файл не похож на изображение указанного формата." });
        return;
      }
      await fs.mkdir(ASSETS_DIR, { recursive: true });
      const filename = `${randomUUID()}${type.extension}`;
      await fs.writeFile(path.join(ASSETS_DIR, filename), image, { flag: "wx" });
      sendJson(response, 201, { path: `assets/${filename}` });
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/admin.html" && !getSession(request)) {
      const loginPage = await fs.readFile(path.join(ROOT, "admin-login.html"));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      if (request.method === "HEAD") response.end();
      else response.end(loginPage);
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") &&
        ["/admin.js", "/admin.css"].includes(url.pathname) && !getSession(request)) {
      response.writeHead(401, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD, POST" }).end();
      return;
    }
    await serveFile(request, response, url.pathname);
  } catch (error) {
    console.error(`[${request.method} ${url.pathname}]`, error);
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Ошибка сервера. Проверьте консоль Node.js."
      });
    } else {
      response.destroy(error);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`VEXIS TEAM запущен: http://localhost:${PORT}`);
  console.log(`Админ-панель: http://localhost:${PORT}/admin.html`);
  if (HOST === "127.0.0.1") console.log("Сервер доступен только на этом компьютере.");
});
