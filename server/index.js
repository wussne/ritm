import express from "express";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { z } from "zod";

import {
  seed,
  monday,
  addDays,
  today,
  occurrences,
  instant,
} from "../src/domain.js";

import { tusur, driving } from "./providers.js";

// Настройки сервера

const password = process.env.APP_PASSWORD;

if (!password || password.length < 12) {
  throw new Error("Укажите APP_PASSWORD (минимум 12 символов) в .env");
}

if (
  process.env.NODE_ENV === "production" &&
  (process.env.SESSION_SECRET || "").length < 32
) {
  throw new Error("Для production нужен SESSION_SECRET (32+ символа)");
}

const secret =
  process.env.SESSION_SECRET || randomBytes(32).toString("hex");

const directory = path.resolve(process.env.DATA_DIR || "data");

mkdirSync(directory, { recursive: true });

// База данных

const db = new DatabaseSync(path.join(directory, "ritm.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sent (
    id TEXT PRIMARY KEY
  );
`);

if (!db.prepare("SELECT id FROM state WHERE id = 1").get()) {
  db.prepare("INSERT INTO state VALUES (1, 1, ?)").run(
    JSON.stringify(seed()),
  );
}

function getState() {
  const row = db.prepare("SELECT * FROM state WHERE id = 1").get();

  return {
    version: row.version,
    state: JSON.parse(row.data),
  };
}

function getCache() {
  const rows = db.prepare("SELECT * FROM cache").all();

  return Object.fromEntries(
    rows.map((row) => [row.key, JSON.parse(row.data)]),
  );
}

function storeCache(key, value) {
  db.prepare(`
    INSERT INTO cache VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data
  `).run(key, JSON.stringify(value));
}

// Проверка входящих данных

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value + "T12:00Z")) &&
      new Date(value + "T12:00Z").toISOString().startsWith(value),
  );

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const text = z.string().max(20000);
const id = z.string().min(1).max(150);

const student = z.object({
  id,
  name: z.string().min(1).max(120),
  topic: text,
  homework: text,
  next: text,
  materials: text,
  notes: text,

  history: z
    .array(
      z.object({
        id,
        date,
        done: text,
        homework: text,
        next: text,
      }),
    )
    .max(2000),
});

const event = z
  .object({
    id,
    title: z.string().min(1).max(200),
    studentId: z.string().max(150),
    kind: z.enum(["lesson", "personal", "university", "driving"]),
    date,
    time,
    duration: z.number().int().min(5).max(720),
    repeat: z.enum(["none", "weekly"]),
    until: z.union([date, z.literal("")]),
    exceptions: z.array(date).max(2000),
    location: z.string().max(300),
    note: text,
    provisional: z.boolean().optional(),
  })
  .refine(
    (event) => !event.until || event.until >= event.date,
    "Дата окончания раньше начала",
  );

const stateSchema = z
  .object({
    students: z.array(student).max(500),
    events: z.array(event).max(10000),

    notes: z.record(
      z.string().max(160),
      z.object({
        text,
        prepared: z.boolean(),
      }),
    ),

    settings: z
      .object({
        workStart: time,
        workEnd: time,
        breakMinutes: z.number().int().min(0).max(120),
        travelMinutes: z.number().int().min(0).max(180),
        subgroup: z.enum(["all", "а", "б"]),
        reminderMinutes: z.number().int().min(0).max(120),
      })
      .refine(
        (settings) => settings.workEnd > settings.workStart,
        "Рабочий интервал должен заканчиваться позже начала",
      ),
  })
  .superRefine((state, context) => {
    for (const key of ["students", "events"]) {
      const uniqueIds = new Set(state[key].map((item) => item.id));

      if (uniqueIds.size !== state[key].length) {
        context.addIssue({
          code: "custom",
          message: "Повторяющиеся ID",
        });
      }
    }
  });

// Приложение

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "4mb" }));

// Проверки Origin здесь больше нет.
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  });

  if (req.path.startsWith("/api")) {
    res.set("Cache-Control", "no-store");
  }

  next();
});

// Авторизация

function mac(value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function authorized(req) {
  const raw = req.headers.cookie
    ?.split("; ")
    .find((cookie) => cookie.startsWith("ritm_session="))
    ?.slice(13);

  if (!raw) {
    return false;
  }

  const [expires, signature] = raw.split(".");

  return (
    /^\d+$/.test(expires) &&
    Number(expires) > Date.now() &&
    /^[a-f0-9]{64}$/.test(signature || "") &&
    timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(mac(expires)),
    )
  );
}

const attempts = new Map();

app.post("/api/login", (req, res) => {
  const now = Date.now();

  const entry = attempts.get(req.ip) || {
    count: 0,
    until: now + 600000,
  };

  if (now > entry.until) {
    entry.count = 0;
    entry.until = now + 600000;
  }

  if (entry.count >= 12) {
    return res.status(429).json({
      error: "Слишком много попыток. Повторите через 10 минут.",
    });
  }

  const digest = (value) =>
    createHash("sha256").update(String(value)).digest();

  if (!timingSafeEqual(digest(req.body.password), digest(password))) {
    entry.count++;
    attempts.set(req.ip, entry);

    return res.status(401).json({
      error: "Неверный пароль",
    });
  }

  attempts.delete(req.ip);

  const expires = String(now + 7 * 86400000);

  res
    .cookie("ritm_session", expires + "." + mac(expires), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 86400000,
      path: "/",
    })
    .json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (authorized(req)) {
    return next();
  }

  res.status(401).json({
    error: "Войдите в свой Ритм",
  });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("ritm_session", { path: "/" }).json({
    ok: true,
  });
});

// Чтение и сохранение данных

app.get("/api/state", (req, res) => {
  res.json({
    ...getState(),
    cache: getCache(),

    connections: {
      driving: Boolean(process.env.DS_COOKIE),
      telegram: Boolean(
        process.env.TELEGRAM_BOT_TOKEN &&
          process.env.TELEGRAM_CHAT_ID,
      ),
    },
  });
});

app.put("/api/state", (req, res) => {
  const parsed = stateSchema.safeParse(req.body.state);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message || "Некорректные данные",
    });
  }

  const version = req.body.version;

  if (!Number.isInteger(version)) {
    return res.status(400).json({
      error: "Нет версии данных",
    });
  }

  const result = db
    .prepare(`
      UPDATE state
      SET version = version + 1, data = ?
      WHERE id = 1 AND version = ?
    `)
    .run(JSON.stringify(parsed.data), version);

  if (!result.changes) {
    return res.status(409).json({
      error:
        "Данные изменены на другом устройстве. " +
        "Обновите страницу перед повторным сохранением.",
    });
  }

  res.json({
    version: version + 1,
    state: parsed.data,
  });
});

// Синхронизация расписания

const running = new Map();

async function syncSource(source, start) {
  const key = source + ":" + start;

  if (running.has(key)) {
    return running.get(key);
  }

  const job = (async () => {
    const previous = getCache()[key] || {
      events: [],
      lastSuccess: null,
    };

    try {
      const value = await (
        source === "university" ? tusur(start) : driving(start)
      );

      const result = {
        ...value,
        lastSuccess: new Date().toISOString(),
        lastAttempt: new Date().toISOString(),
        error: null,
      };

      storeCache(key, result);
      return result;
    } catch (error) {
      let message = error.message;

      if (error.name === "TimeoutError") {
        message =
          "Источник не ответил вовремя. Сохранена предыдущая версия.";
      } else if (
        error.message.startsWith("fetch") ||
        error.message.includes("redirect")
      ) {
        message =
          "Не удалось подключиться к источнику. " +
          "Сохранена предыдущая версия.";
      }

      const result = {
        ...previous,
        lastAttempt: new Date().toISOString(),
        error: message,
      };

      storeCache(key, result);
      return result;
    } finally {
      running.delete(key);
    }
  })();

  running.set(key, job);
  return job;
}

app.post("/api/sync", async (req, res) => {
  const check = date.safeParse(req.body.week);

  if (!check.success || monday(check.data) !== check.data) {
    return res.status(400).json({
      error: "Нужна дата понедельника выбранной недели",
    });
  }

  const week = check.data;

  if (Math.abs(Date.parse(week) - Date.parse(today())) > 550 * 86400000) {
    return res.status(400).json({
      error: "Выберите неделю в пределах полутора лет",
    });
  }

  await Promise.all(
    ["university", "driving"].map((source) => syncSource(source, week)),
  );

  res.json({
    cache: getCache(),
  });
});

app.get("/api/export", (req, res) => {
  res.attachment("ritm-backup.json").json({
    schema: 1,
    ...getState(),
    cache: getCache(),
  });
});

// Фоновое обновление: работает и при закрытом браузере.

let ticking = false;

async function background() {
  if (ticking) {
    return;
  }

  ticking = true;

  try {
    const week = monday(today());

    if (process.env.NODE_ENV === "production") {
      await Promise.all(
        [week, addDays(week, 7)].flatMap((start) =>
          ["university", "driving"]
            .filter(
              (source) =>
                source === "university" || process.env.DS_COOKIE,
            )
            .map((source) => syncSource(source, start)),
        ),
      );
    }

    await reminders();
  } finally {
    ticking = false;
  }
}

// Напоминания в Telegram

async function reminders() {
  if (
    !process.env.TELEGRAM_BOT_TOKEN ||
    !process.env.TELEGRAM_CHAT_ID
  ) {
    return;
  }

  const { state } = getState();
  const now = Date.now();

  if (!state.settings.reminderMinutes) {
    return;
  }

  const events = occurrences(
    state,
    today(),
    addDays(today(), 2),
    getCache(),
  );

  for (const event of events) {
    const due = instant(event.start);
    const delta = due - now;
    const key = event.id + ":" + event.start;

    if (
      delta <= 0 ||
      delta > state.settings.reminderMinutes * 60000 ||
      db.prepare("SELECT id FROM sent WHERE id = ?").get(key)
    ) {
      continue;
    }

    const note = state.notes[event.id]?.text || event.note || "";
    const student = state.students.find(
      (item) => item.id === event.studentId,
    );

    const message =
      `${event.start.slice(11)} · ${event.title}\n` +
      `${event.location || ""}\n` +
      `${student?.next ? "План: " + student.next + "\n" : ""}` +
      note;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message.slice(0, 3900),
          }),
          signal: AbortSignal.timeout(10000),
        },
      );

      const body = await response.json();

      if (response.ok && body.ok) {
        db.prepare("INSERT OR IGNORE INTO sent VALUES (?)").run(key);
      }
    } catch {
      console.error("Не удалось отправить напоминание");
    }
  }
}

setInterval(() => {
  background().catch(() => {
    console.error("Ошибка фонового обновления");
  });
}, 15 * 60000).unref();

setInterval(() => {
  reminders().catch(() => {
    console.error("Ошибка напоминаний");
  });
}, 30000).unref();

// Готовая сборка интерфейса

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve("dist")));
}

// Обработка ошибок

app.use((err, req, res, next) => {
  console.error(err.name);

  res.status(500).json({
    error: "Не удалось выполнить запрос. Данные не удалены.",
  });
});

// Запуск

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";

app.listen(port, host, () => {
  console.log("Ритм: сервер готов, порт " + port);
});