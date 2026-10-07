const content = { players: [], news: [], matches: [], tournaments: [], shop: [] };
const definitions = {
  players: {
    label: "Состав команды", singular: "игрока", plural: "Игроки",
    fields: [
      { name: "firstName", label: "Имя", required: true, placeholder: "Например, Егор" },
      { name: "nickname", label: "Игровой ник", required: true, placeholder: "Например, Tikhonkiy" },
      { name: "lastName", label: "Фамилия", placeholder: "Например, Ибрагимов" },
      { name: "country", label: "Национальность", placeholder: "Например, Россия" },
      { name: "role", label: "Роль в команде", placeholder: "Например, Entry" },
      { name: "photo", label: "Фотография", type: "image" },
      { name: "stats", label: "Статистика игрока", type: "lines", format: "label | значение", help: "Каждая строка — один показатель. Оставьте поле пустым, если данных пока нет." },
      { name: "matches", label: "История матчей", type: "lines", format: "дата | соперник | счёт | результат", help: "Например: 2026-10-07 | Название команды | 2:1 | Победа" },
      { name: "tournaments", label: "Результаты на турнирах", type: "lines", format: "турнир | место или результат | год", help: "Например: Название турнира | 1-е место | 2026" }
    ],
    title: item => item.nickname || item.firstName || "Игрок",
    subtitle: item => [item.firstName, item.lastName, item.country, item.role].filter(Boolean).join(" · ")
  },
  news: {
    label: "Новости", singular: "новость", plural: "Новости",
    fields: [
      { name: "title", label: "Заголовок", required: true },
      { name: "date", label: "Дата", type: "date" },
      { name: "category", label: "Категория", placeholder: "Например, Команда" },
      { name: "text", label: "Текст новости", type: "textarea", required: true }
    ],
    title: item => item.title || "Новость",
    subtitle: item => [item.category, item.date].filter(Boolean).join(" · ")
  },
  matches: {
    label: "Матчи", singular: "матч", plural: "Матчи",
    fields: [
      { name: "date", label: "Дата", type: "date" },
      { name: "opponent", label: "Соперник", required: true },
      { name: "score", label: "Счёт", placeholder: "Например, 2:1" },
      { name: "result", label: "Результат", type: "select", options: ["", "Победа", "Поражение", "Ничья"] }
    ],
    title: item => item.opponent || "Матч",
    subtitle: item => [item.date, item.score, item.result].filter(Boolean).join(" · ")
  },
  tournaments: {
    label: "Турниры", singular: "турнир", plural: "Турниры",
    fields: [
      { name: "name", label: "Название турнира", required: true },
      { name: "placement", label: "Место или результат", placeholder: "Например, 1-е место" },
      { name: "year", label: "Год", placeholder: "Например, 2026" }
    ],
    title: item => item.name || "Турнир",
    subtitle: item => [item.placement, item.year].filter(Boolean).join(" · ")
  },
  shop: {
    label: "Магазин", singular: "товар", plural: "Товары",
    fields: [
      { name: "name", label: "Название товара", required: true },
      { name: "description", label: "Описание", type: "textarea" },
      { name: "price", label: "Цена или статус", placeholder: "Например, Скоро" },
      { name: "photo", label: "Фотография товара", type: "image" }
    ],
    title: item => item.name || "Товар",
    subtitle: item => [item.description, item.price].filter(Boolean).join(" · ")
  }
};

let currentType = "players";
let editingId = null;
let currentPhoto = "";
const form = document.getElementById("entryForm");
const list = document.getElementById("entryList");
const statusBox = document.getElementById("status");
const cancelButton = document.getElementById("cancelEdit");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
  statusBox.classList.add("visible");
}

function clearStatus() {
  statusBox.textContent = "";
  statusBox.classList.remove("visible", "error");
}

async function request(url, options) {
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Ошибка сервера (${response.status}).`);
  return result;
}

function parseLines(value, field) {
  const rows = value.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (field.name === "stats") return rows.map(row => {
    const [label = "", ...rest] = row.split("|");
    return { label: label.trim(), value: rest.join("|").trim() };
  });
  if (field.name === "matches") return rows.map(row => {
    const [date = "", opponent = "", score = "", result = ""] = row.split("|").map(part => part.trim());
    return { date, opponent, score, result };
  });
  return rows.map(row => {
    const [name = "", placement = "", year = ""] = row.split("|").map(part => part.trim());
    return { name, placement, year };
  });
}

function formatLines(value) {
  if (!Array.isArray(value)) return "";
  return value.map(item => {
    if (typeof item === "string") return item;
    if (item.label !== undefined) return `${item.label} | ${item.value || ""}`;
    if (item.opponent !== undefined) return [item.date, item.opponent, item.score, item.result].join(" | ");
    return [item.name, item.placement, item.year].filter(Boolean).join(" | ");
  }).join("\n");
}

function renderField(field, item = {}) {
  const value = field.type === "lines" ? formatLines(item[field.name]) : (item[field.name] || "");
  const hint = field.help ? `<small>${escapeHtml(field.help)}</small>` : "";
  let control;
  if (field.type === "textarea" || field.type === "lines") {
    control = `<textarea id="field-${field.name}" name="${field.name}" ${field.required ? "required" : ""} ${field.type === "lines" ? `placeholder="${escapeHtml(field.format)}"` : ""}>${escapeHtml(value)}</textarea>`;
  } else if (field.type === "select") {
    control = `<select id="field-${field.name}" name="${field.name}">${field.options.map(option => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option || "Не указано")}</option>`).join("")}</select>`;
  } else if (field.type === "image") {
    const preview = value ? `<img class="preview" src="/${escapeHtml(value.replace(/^\/+/, ""))}" alt="Текущее изображение">` : "";
    control = `${preview}<input id="field-${field.name}" name="${field.name}" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPG или WebP, максимум 5 МБ. ${value ? "Текущее фото сохранится, если новый файл не выбрать." : ""}</small>`;
  } else {
    control = `<input id="field-${field.name}" name="${field.name}" type="${field.type || "text"}" value="${escapeHtml(value)}" ${field.required ? "required" : ""} placeholder="${escapeHtml(field.placeholder || "")}">`;
  }
  return `<div class="field"><label for="field-${field.name}">${escapeHtml(field.label)}${field.required ? " *" : ""}</label>${control}${hint}</div>`;
}

function resetForm() {
  editingId = null;
  currentPhoto = "";
  form.reset();
  document.getElementById("formTitle").textContent = `Добавить ${definitions[currentType].singular}`;
  cancelButton.classList.add("hidden");
  renderForm();
}

function renderForm(item = {}) {
  const fields = definitions[currentType].fields.map(field => renderField(field, item)).join("");
  form.innerHTML = `${fields}<div class="form-actions"><button class="button primary" type="submit">${editingId ? "Сохранить изменения" : "Добавить"}</button><button class="button secondary" type="reset">Очистить</button></div>`;
}

function renderList() {
  const definition = definitions[currentType];
  const entries = content[currentType];
  document.getElementById("sectionEyebrow").textContent = definition.label;
  document.getElementById("listTitle").textContent = definition.plural;
  document.getElementById("entryCount").textContent = entries.length;
  if (!entries.length) {
    list.innerHTML = `<div class="empty">Пока записей нет.<br>Заполните форму и нажмите «Добавить».</div>`;
    return;
  }
  list.innerHTML = entries.map(item => {
    const image = item.photo ? `<img class="entry-thumb" src="/${escapeHtml(item.photo.replace(/^\/+/, ""))}" alt="">` : "";
    return `<article class="entry-card">${image}<div class="entry-content"><strong>${escapeHtml(definition.title(item))}</strong><span>${escapeHtml(definition.subtitle(item) || "Дополнительные сведения не указаны")}</span></div><div class="entry-actions"><button type="button" class="small-button" data-edit="${escapeHtml(item.id)}">Изменить</button><button type="button" class="small-button delete" data-delete="${escapeHtml(item.id)}">Удалить</button></div></article>`;
  }).join("");
}

async function loadContent() {
  Object.assign(content, await request("/api/content"));
  renderList();
}

async function saveContent() {
  await request("/api/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(content)
  });
  try {
    const channel = new BroadcastChannel("vexis-content");
    channel.postMessage("updated");
    channel.close();
  } catch (error) {
    console.info("Открытая вкладка сайта обновится после перезагрузки.", error);
  }
}

async function uploadImage(file) {
  if (!file) return "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Поддерживаются изображения PNG, JPG и WebP.");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("Фотография должна быть не больше 5 МБ.");
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать выбранный файл."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
  const uploaded = await request("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: file.type, data: base64 })
  });
  return uploaded.path;
}

function chooseType(type) {
  currentType = type;
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.type === type));
  clearStatus();
  resetForm();
  renderList();
}

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => chooseType(tab.dataset.type)));

form.addEventListener("submit", async event => {
  event.preventDefault();
  clearStatus();
  const definition = definitions[currentType];
  const entry = editingId ? { ...content[currentType].find(item => item.id === editingId) } : { id: crypto.randomUUID() };
  try {
    for (const field of definition.fields) {
      const control = form.elements.namedItem(field.name);
      if (field.type === "image") {
        const file = control.files[0];
        if (file) entry[field.name] = await uploadImage(file);
        else if (field.name === "photo" && !editingId) entry[field.name] = "";
      } else if (field.type === "lines") {
        entry[field.name] = parseLines(control.value, field);
      } else {
        entry[field.name] = control.value.trim();
      }
    }
    const entries = content[currentType];
    const previousEntries = [...entries];
    const existingIndex = entries.findIndex(item => item.id === editingId);
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else entries.unshift(entry);
    try {
      await saveContent();
    } catch (error) {
      content[currentType] = previousEntries;
      throw error;
    }
    renderList();
    resetForm();
    setStatus("Изменения сохранены. Сайт уже обновлён.");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Не удалось сохранить изменения.", true);
  }
});

form.addEventListener("reset", event => {
  if (event.submitter) return;
  if (editingId) {
    event.preventDefault();
    resetForm();
  }
});

list.addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    editingId = editButton.dataset.edit;
    const item = content[currentType].find(entry => entry.id === editingId);
    if (!item) return;
    currentPhoto = item.photo || "";
    document.getElementById("formTitle").textContent = `Изменить: ${definitions[currentType].title(item)}`;
    cancelButton.classList.remove("hidden");
    clearStatus();
    renderForm(item);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const deleteButton = event.target.closest("[data-delete]");
  if (!deleteButton) return;
  const item = content[currentType].find(entry => entry.id === deleteButton.dataset.delete);
  if (!item || !window.confirm(`Удалить «${definitions[currentType].title(item)}»?`)) return;
  const previous = [...content[currentType]];
  content[currentType] = content[currentType].filter(entry => entry.id !== item.id);
  try {
    await saveContent();
    renderList();
    if (editingId === item.id) resetForm();
    setStatus("Запись удалена.");
  } catch (error) {
    content[currentType] = previous;
    renderList();
    console.error(error);
    setStatus(error.message || "Не удалось удалить запись.", true);
  }
});

cancelButton.addEventListener("click", resetForm);
loadContent().catch(error => {
  console.error(error);
  setStatus(`Не удалось загрузить данные: ${error.message} Убедитесь, что Node.js-сервер запущен.`, true);
});
