const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = __dirname;
const START_PORT = Number(process.env.VEXIS_PORT_START) || 3000;
const MAX_PORTS_TO_TRY = 100;
const adminMode = process.argv[2] === "admin";
const mode = adminMode ? "admin.html" : "";
let keypressEnabled = false;

async function ownServerIsRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500)
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health.app === "vexis-team" && path.resolve(health.root) === path.resolve(ROOT) ? health : false;
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

function startServer(port, adminPassword) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...(adminPassword ? { ADMIN_PASSWORD: adminPassword } : {}) },
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function waitForServer(port, child, requireAdmin) {
  const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = await ownServerIsRunning(port);
    if (health && (!requireAdmin || health.adminConfigured)) return true;
    if (await isPortOccupied(port)) return false;
    const exited = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
    if (exited) return false;
  }
  return false;
}

function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Для безопасного ввода пароля запустите админку из файла .bat в окне командной строки."));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    if (!keypressEnabled) {
      readline.emitKeypressEvents(process.stdin);
      keypressEnabled = true;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKeypress = (text, key) => {
      if (key && key.ctrl && key.name === "c") {
        process.stdin.off("keypress", onKeypress);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        reject(new Error("Запуск отменён."));
      } else if (key && key.name === "return") {
        process.stdin.off("keypress", onKeypress);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(value);
      } else if (key && key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (text && !key.ctrl && !key.meta) {
        value += text;
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function promptForAdminPassword() {
  if (process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD должен содержать не менее 12 символов.");
    return process.env.ADMIN_PASSWORD;
  }
  const password = await readHiddenLine("Создайте пароль админки (не менее 12 символов): ");
  const confirmation = await readHiddenLine("Повторите пароль: ");
  if (password.length < 12) throw new Error("Пароль должен содержать не менее 12 символов.");
  if (password !== confirmation) throw new Error("Пароли не совпадают.");
  return password;
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
  let adminPassword;
  for (let index = 0; index < MAX_PORTS_TO_TRY; index += 1) {
    const port = START_PORT + index;
    const health = await ownServerIsRunning(port);
    if (health && (!adminMode || health.adminConfigured)) {
      const url = `http://localhost:${port}/${mode}`;
      console.log(`Сайт уже запущен: ${url}`);
      openBrowser(url);
      return;
    }
    if (await isPortOccupied(port)) continue;

    if (adminMode && !adminPassword) adminPassword = await promptForAdminPassword();
    const child = startServer(port, adminPassword);
    if (await waitForServer(port, child, adminMode)) {
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
