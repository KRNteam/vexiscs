const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const ROOT = __dirname;
const START_PORT = Number(process.env.VEXIS_PORT_START) || 3000;
const MAX_PORTS_TO_TRY = 100;
const mode = process.argv[2] === "admin" ? "admin.html" : "";

async function ownServerIsRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500)
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health.app === "vexis-team" && path.resolve(health.root) === path.resolve(ROOT);
  } catch {
    return false;
  }
}

function isPortOccupied(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", error => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH") resolve(false);
      else reject(error);
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function waitForServer(port, child) {
  const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await ownServerIsRunning(port)) return true;
    if (await isPortOccupied(port)) return false;
    const exited = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
    if (exited) return false;
  }
  return false;
}

function openBrowser(url) {
  const browser = spawn("cmd.exe", ["/d", "/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  browser.once("error", () => {
    console.log(`Откройте в браузере: ${url}`);
  });
  browser.unref();
}

async function main() {
  for (let index = 0; index < MAX_PORTS_TO_TRY; index += 1) {
    const port = START_PORT + index;
    if (await ownServerIsRunning(port)) {
      const url = `http://localhost:${port}/${mode}`;
      console.log(`Сайт уже запущен: ${url}`);
      openBrowser(url);
      return;
    }
    if (await isPortOccupied(port)) continue;

    const child = startServer(port);
    if (await waitForServer(port, child)) {
      const url = `http://localhost:${port}/${mode}`;
      console.log(`VEXIS TEAM запущен: ${url}`);
      openBrowser(url);
      return;
    }
  }
  throw new Error("Не удалось запустить сайт: порты 3000–3099 заняты или недоступны.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
