const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { exec, spawn } = require("child_process");

const configPath = path.join(__dirname, "config.json");
const VALID_ROLES = ["admin", "operator", "viewer"];
const TOKEN_DAYS = 30;

function defaultCameras() {
  return [
    {
      id: "cam",
      name: "Camera 1",
      group: "Khu vực chính",
      enabled: true,
      autoConnect: true,
      path: "cam",
      sensorIds: [],
    },
  ];
}

function sanitizeId(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || fallback;
}

function normalizeCamera(cam, index) {
  const fallback = "cam" + (index === 0 ? "" : index + 1);
  const id = sanitizeId(cam && (cam.id || cam.path), fallback);
  return {
    id,
    name: cam && cam.name ? String(cam.name).trim() : id,
    group: cam && cam.group ? String(cam.group).trim() : "Khu vực chính",
    enabled: !cam || cam.enabled !== false,
    autoConnect: !cam || cam.autoConnect !== false,
    path: sanitizeId(cam && cam.path, id),
    sensorIds: Array.isArray(cam && cam.sensorIds)
      ? cam.sensorIds.map((s) => String(s).trim()).filter(Boolean)
      : [],
  };
}

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    enabled: user.enabled !== false,
  };
}

function normalizeUser(raw, index) {
  const username = sanitizeId(
    raw && (raw.username || raw.id),
    "user" + (index + 1),
  ).toLowerCase();
  let role = String((raw && raw.role) || "viewer").toLowerCase();
  if (!VALID_ROLES.includes(role)) role = "viewer";
  let passwordHash = raw && raw.passwordHash ? String(raw.passwordHash) : "";
  if (raw && raw.password) passwordHash = hashPassword(raw.password);
  if (!passwordHash) passwordHash = hashPassword("123");
  return {
    id: sanitizeId(raw && raw.id, username),
    username,
    name: raw && raw.name ? String(raw.name).trim() : username,
    role,
    passwordHash,
    enabled: !raw || raw.enabled !== false,
  };
}

const MEAL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_TO_DAY = {
  Sun: "sun",
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
};
const sentScheduleSlots = new Set();

function mealName(value) {
  return value ? String(value).trim().slice(0, 80) : "";
}

const SOUND_EVENTS = ["gas", "emergency", "meal", "home"];
const SOUND_RENAMES = {
  "con-cac_h9fXgQu.mp3": "con-cac-tran-dan.mp3",
  "crazy-realistic-knocking-sound-troll-twitch-streamers_small.mp3":
    "crazy-realistic-knocking-sound.mp3",
  "nom-nom-nom_gPJiWn4.mp3": "nom-nom-nom.mp3",
  "siren.mp3": "hachimi.mp3",
};
const soundsDir = path.join(__dirname, "public", "sounds");

function safeSoundName(name) {
  const base = path.basename(String(name || ""));
  if (!/^[a-zA-Z0-9._-]+\.(mp3|wav|ogg|m4a)$/i.test(base)) return "";
  return base;
}

function listSoundFiles() {
  if (!fs.existsSync(soundsDir)) return [];
  return fs
    .readdirSync(soundsDir)
    .map(safeSoundName)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function resolveSoundName(name) {
  let file = safeSoundName(name);
  if (file && SOUND_RENAMES[file]) file = SOUND_RENAMES[file];
  return file;
}

function normalizeSoundList(value, files) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const list = [];
  raw.forEach((item) => {
    const file = resolveSoundName(item);
    if (file && files.has(file) && !seen.has(file)) {
      seen.add(file);
      list.push(file);
    }
  });
  return list;
}

function normalizeSoundAssignments(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const files = new Set(listSoundFiles());
  const out = {};
  SOUND_EVENTS.forEach((key) => {
    out[key] = normalizeSoundList(source[key], files);
  });
  return out;
}

function normalizeMealSchedule(raw) {
  const source = Array.isArray(raw) ? raw : [];
  return MEAL_DAYS.map((day) => {
    const row = source.find((item) => item && item.day === day) || {};
    const people = Array.isArray(row.people) ? row.people : [];
    return {
      day,
      name1: mealName(row.name1 || people[0] || row.name),
      name2: mealName(row.name2 || people[1]),
    };
  });
}

function vietnamNow() {
  const map = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  parts.forEach((part) => {
    if (part.type !== "literal") map[part.type] = part.value;
  });
  return {
    weekday: map.weekday,
    day: WEEKDAY_TO_DAY[map.weekday] || "mon",
    hour: Number(map.hour),
    minute: Number(map.minute),
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

function todayMealDutyLabel() {
  const now = vietnamNow();
  const row = (config.mealSchedule || []).find((item) => item.day === now.day);
  const names = [row && row.name1, row && row.name2]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return names.length ? names.join(", ") : "Chưa phân công";
}

function emitScheduledAlert(kind) {
  const isMeal = kind === "meal";
  const payload = {
    kind,
    title: isMeal ? "Đến giờ dọn cơm" : "Chuẩn bị về",
    message: isMeal
      ? `Hôm nay: ${todayMealDutyLabel()}`
      : "Đến giờ chuẩn bị về",
    timestamp: new Date().toISOString(),
  };
  io.emit("SCHEDULED_ALERT", payload);
  console.log(`[SCHEDULE] ${payload.title} — ${payload.message}`);
}

function checkScheduledAlerts() {
  const now = vietnamNow();
  if (now.weekday === "Sun") return;
  let kind = null;
  if (now.hour === 11 && now.minute === 45) kind = "meal";
  else if (now.hour === 17 && now.minute === 55) kind = "home";
  if (!kind) return;
  const key = `${now.dateKey}:${kind}`;
  if (sentScheduleSlots.has(key)) return;
  sentScheduleSlots.add(key);
  Array.from(sentScheduleSlots).forEach((slot) => {
    if (!slot.startsWith(now.dateKey)) sentScheduleSlots.delete(slot);
  });
  emitScheduledAlert(kind);
}

function startScheduleWatcher() {
  checkScheduledAlerts();
  setInterval(checkScheduledAlerts, 15000);
  console.log(
    "Lịch thông báo: 11:45 dọn cơm, 17:55 chuẩn bị về (T2–T7, nghỉ CN)",
  );
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const cameras =
    Array.isArray(source.cameras) && source.cameras.length
      ? source.cameras.map(normalizeCamera)
      : defaultCameras();
  let users =
    Array.isArray(source.users) && source.users.length
      ? source.users.map(normalizeUser)
      : [
          normalizeUser(
            {
              username: "admin",
              name: "Quản trị viên",
              role: "admin",
              password: source.password || "123",
            },
            0,
          ),
        ];
  if (!users.some((u) => u.role === "admin" && u.enabled !== false)) {
    users[0].role = "admin";
    users[0].enabled = true;
  }
  const sessionSecret =
    source.sessionSecret && String(source.sessionSecret).length >= 16
      ? String(source.sessionSecret)
      : crypto.randomBytes(32).toString("hex");
  const mealSchedule = normalizeMealSchedule(source.mealSchedule);
  const sounds = normalizeSoundAssignments(source.sounds);
  return { cameras, users, sessionSecret, mealSchedule, sounds };
}

function needsPersist(raw) {
  if (!raw || typeof raw !== "object") return true;
  if (!raw.sessionSecret || String(raw.sessionSecret).length < 16) return true;
  if (!Array.isArray(raw.users) || !raw.users.length) return true;
  if (raw.password) return true;
  if (raw.users.some((u) => u && u.password && !u.passwordHash)) return true;
  if (!raw.sounds || typeof raw.sounds !== "object") return true;
  if (
    SOUND_EVENTS.some(
      (key) => raw.sounds[key] != null && !Array.isArray(raw.sounds[key]),
    )
  ) {
    return true;
  }
  return false;
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    const created = normalizeConfig({ password: "123" });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          sessionSecret: created.sessionSecret,
          users: created.users,
          cameras: created.cameras,
          mealSchedule: created.mealSchedule,
          sounds: created.sounds,
        },
        null,
        2,
      ),
    );
    return created;
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const normalized = normalizeConfig(raw);
  if (needsPersist(raw)) {
    const toSave = {
      sessionSecret: normalized.sessionSecret,
      users: normalized.users,
      cameras: normalized.cameras,
      mealSchedule: normalized.mealSchedule,
      sounds: normalized.sounds,
    };
    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2));
  }
  return normalized;
}

function saveConfig() {
  const toSave = {
    sessionSecret: config.sessionSecret,
    users: config.users,
    cameras: config.cameras,
    mealSchedule: config.mealSchedule,
    sounds: config.sounds,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2));
  writeMediaMTXConfigFile();
}

function publicConfig(user) {
  return {
    webrtcPort: 8889,
    rtspPort: 8554,
    cameras: config.cameras,
    mealSchedule: config.mealSchedule,
    sounds: config.sounds,
    soundFiles: listSoundFiles(),
    me: publicUser(user),
  };
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx < 0) return;
      out[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    });
  return out;
}

function setAuthCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `auth_token=${token}; Max-Age=${TOKEN_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "auth_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
  );
}

function signToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      exp: Date.now() + TOKEN_DAYS * 86400 * 1000,
    }),
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto
    .createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || data.exp < Date.now() || !data.uid) return null;
    return data.uid;
  } catch (err) {
    return null;
  }
}

function userFromRequest(req) {
  const uid = verifyToken(parseCookies(req).auth_token);
  if (!uid) return null;
  return config.users.find((u) => u.id === uid && u.enabled !== false) || null;
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user)
      return res.status(401).json({ success: false, error: "Unauthorized" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: "Không có quyền thực hiện thao tác này",
      });
    }
    next();
  };
}

let config = loadConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  req.user = userFromRequest(req);
  const PUBLIC_PATHS = [
    "/login.html",
    "/style.css",
    "/api/trigger",
    "/api/login",
    "/api/logout",
    "/siren.mp3",
  ];
  if (
    PUBLIC_PATHS.includes(req.path) ||
    req.path.startsWith("/socket.io/") ||
    req.path.startsWith("/sounds/")
  ) {
    return next();
  }
  if (req.user) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login.html");
});

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/login", (req, res) => {
  const username = String((req.body && req.body.username) || "")
    .trim()
    .toLowerCase();
  const password = String((req.body && req.body.password) || "");
  const user = config.users.find(
    (u) => u.username === username && u.enabled !== false,
  );
  let ok = false;
  try {
    ok = Boolean(user && bcrypt.compareSync(password, user.passwordHash));
  } catch (err) {
    ok = false;
  }
  if (!ok) {
    return res.json({ success: false, error: "Sai tài khoản hoặc mật khẩu" });
  }
  setAuthCookie(res, signToken(user.id));
  res.json({ success: true, user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get("/api/me", (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

app.post("/api/change-password", (req, res) => {
  updateOwnAccount(req, res);
});

app.put("/api/me", (req, res) => {
  updateOwnAccount(req, res);
});

function updateOwnAccount(req, res) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const body = req.body || {};
  const currentPassword = String(body.currentPassword || "");
  const newPass = String(body.newPassword || body.password || "");
  const nextUsername = sanitizeId(
    body.username || req.user.username,
    req.user.username,
  ).toLowerCase();
  let match = false;
  try {
    match = bcrypt.compareSync(currentPassword, req.user.passwordHash);
  } catch (err) {
    match = false;
  }
  if (!match) {
    return res.json({ success: false, error: "Mật khẩu hiện tại không đúng" });
  }
  if (newPass && newPass.length < 3) {
    return res.json({
      success: false,
      error: "Mật khẩu mới tối thiểu 3 ký tự",
    });
  }
  if (
    nextUsername !== req.user.username &&
    config.users.some(
      (u) => u.id !== req.user.id && u.username === nextUsername,
    )
  ) {
    return res.json({ success: false, error: "Tên đăng nhập đã được dùng" });
  }
  req.user.username = nextUsername;
  if (newPass) req.user.passwordHash = hashPassword(newPass);
  saveConfig();
  res.json({ success: true, user: publicUser(req.user) });
}

app.get("/api/config", (req, res) => {
  res.json(publicConfig(req.user));
});

app.put("/api/sounds", requireRole("admin", "operator"), (req, res) => {
  config.sounds = normalizeSoundAssignments(req.body && req.body.sounds);
  saveConfig();
  io.emit("SOUNDS_UPDATED", {
    sounds: config.sounds,
    soundFiles: listSoundFiles(),
  });
  res.json({
    success: true,
    sounds: config.sounds,
    soundFiles: listSoundFiles(),
  });
});

app.put("/api/meal-schedule", requireRole("admin", "operator"), (req, res) => {
  config.mealSchedule = normalizeMealSchedule(req.body && req.body.days);
  saveConfig();
  io.emit("MEAL_SCHEDULE_UPDATED", { mealSchedule: config.mealSchedule });
  res.json({ success: true, mealSchedule: config.mealSchedule });
});

app.post("/api/cameras", requireRole("admin"), (req, res) => {
  const cam = normalizeCamera(req.body || {}, config.cameras.length);
  if (config.cameras.some((c) => c.id === cam.id || c.path === cam.path)) {
    return res
      .status(409)
      .json({ success: false, error: "Camera id/path đã tồn tại" });
  }
  config.cameras.push(cam);
  saveConfig();
  res.json({ success: true, camera: cam, config: publicConfig(req.user) });
});

app.put("/api/cameras/:id", requireRole("admin"), (req, res) => {
  const idx = config.cameras.findIndex((c) => c.id === req.params.id);
  if (idx < 0) {
    return res
      .status(404)
      .json({ success: false, error: "Không tìm thấy camera" });
  }
  const merged = normalizeCamera(
    { ...config.cameras[idx], ...req.body, id: req.params.id },
    idx,
  );
  const clash = config.cameras.find(
    (c, i) => i !== idx && (c.id === merged.id || c.path === merged.path),
  );
  if (clash) {
    return res.status(409).json({ success: false, error: "path bị trùng" });
  }
  config.cameras[idx] = merged;
  saveConfig();
  res.json({ success: true, camera: merged, config: publicConfig(req.user) });
});

app.delete("/api/cameras/:id", requireRole("admin"), (req, res) => {
  if (config.cameras.length <= 1) {
    return res
      .status(400)
      .json({ success: false, error: "Phải giữ ít nhất 1 camera" });
  }
  const before = config.cameras.length;
  config.cameras = config.cameras.filter((c) => c.id !== req.params.id);
  if (config.cameras.length === before) {
    return res
      .status(404)
      .json({ success: false, error: "Không tìm thấy camera" });
  }
  saveConfig();
  res.json({ success: true, config: publicConfig(req.user) });
});

app.get("/api/users", requireRole("admin"), (req, res) => {
  res.json({ success: true, users: config.users.map(publicUser) });
});

app.post("/api/users", requireRole("admin"), (req, res) => {
  const body = req.body || {};
  const password = String(body.password || "");
  if (password.length < 3) {
    return res
      .status(400)
      .json({ success: false, error: "Mật khẩu tối thiểu 3 ký tự" });
  }
  const user = normalizeUser(
    {
      username: body.username,
      name: body.name,
      role: body.role,
      password,
      enabled: body.enabled,
    },
    config.users.length,
  );
  if (
    config.users.some((u) => u.username === user.username || u.id === user.id)
  ) {
    return res
      .status(409)
      .json({ success: false, error: "Tên đăng nhập đã tồn tại" });
  }
  config.users.push(user);
  saveConfig();
  res.json({
    success: true,
    user: publicUser(user),
    users: config.users.map(publicUser),
  });
});

app.put("/api/users/:id", requireRole("admin"), (req, res) => {
  const idx = config.users.findIndex((u) => u.id === req.params.id);
  if (idx < 0) {
    return res
      .status(404)
      .json({ success: false, error: "Không tìm thấy tài khoản" });
  }
  const body = req.body || {};
  const current = config.users[idx];
  const next = normalizeUser(
    {
      ...current,
      name: body.name != null ? body.name : current.name,
      role: body.role != null ? body.role : current.role,
      enabled: body.enabled != null ? body.enabled : current.enabled,
      password: body.password ? body.password : undefined,
      passwordHash: body.password ? undefined : current.passwordHash,
    },
    idx,
  );
  next.id = current.id;
  next.username = current.username;
  if (next.role !== "admin" || next.enabled === false) {
    const otherAdmin = config.users.some(
      (u, i) => i !== idx && u.role === "admin" && u.enabled !== false,
    );
    if (!otherAdmin) {
      return res
        .status(400)
        .json({ success: false, error: "Phải giữ ít nhất 1 quản trị viên" });
    }
  }
  config.users[idx] = next;
  saveConfig();
  res.json({
    success: true,
    user: publicUser(next),
    users: config.users.map(publicUser),
  });
});

app.delete("/api/users/:id", requireRole("admin"), (req, res) => {
  if (req.params.id === req.user.id) {
    return res
      .status(400)
      .json({ success: false, error: "Không thể xóa chính mình" });
  }
  const target = config.users.find((u) => u.id === req.params.id);
  if (!target) {
    return res
      .status(404)
      .json({ success: false, error: "Không tìm thấy tài khoản" });
  }
  if (target.role === "admin") {
    const otherAdmin = config.users.some(
      (u) => u.id !== target.id && u.role === "admin" && u.enabled !== false,
    );
    if (!otherAdmin) {
      return res
        .status(400)
        .json({ success: false, error: "Phải giữ ít nhất 1 quản trị viên" });
    }
  }
  config.users = config.users.filter((u) => u.id !== req.params.id);
  saveConfig();
  res.json({ success: true, users: config.users.map(publicUser) });
});

app.get("/api/trigger", (req, res) => {
  const sensorId = req.query.sensor_id || "Unknown";
  const distance = req.query.distance || "N/A";
  const timestamp = new Date().toISOString();

  console.log(
    `[ALERT] Phát hiện xâm nhập từ Sensor: ${sensorId} lúc ${timestamp}`,
  );

  io.emit("ALARM_TRIGGERED", {
    sensorId,
    distance,
    timestamp,
  });

  res
    .status(200)
    .json({ success: true, message: "Báo động đã được kích hoạt!" });
});

io.use((socket, next) => {
  const user = userFromRequest(socket.request);
  if (!user) return next(new Error("Unauthorized"));
  socket.user = user;
  next();
});

const EMERGENCY_COOLDOWN_MS = 30000;
const emergencyCooldownByUser = new Map();

io.on("connection", (socket) => {
  const room = "user:" + socket.user.id;
  socket.join(room);
  console.log(`Client connected: ${socket.id} (${socket.user.username})`);

  socket.on("EMERGENCY_ALERT", async (data, ack) => {
    const now = Date.now();
    const until = emergencyCooldownByUser.get(socket.user.id) || 0;
    if (now < until) {
      if (typeof ack === "function") {
        ack({
          success: false,
          error: `Chờ ${Math.ceil((until - now) / 1000)}s để gửi lại`,
          retryAfterMs: until - now,
        });
      }
      return;
    }

    const message =
      String((data && data.message) || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400) || "Bình gas đang di chuyển hãy xóa dấu vết lẹ!";
    const payload = {
      kind: "emergency",
      title: "Cảnh báo khẩn cấp",
      userId: socket.user.id,
      username: socket.user.username,
      name: socket.user.name,
      message,
      timestamp: new Date().toISOString(),
    };
    emergencyCooldownByUser.set(socket.user.id, now + EMERGENCY_COOLDOWN_MS);
    const recipients = await io.in(room).fetchSockets();
    io.to(room).emit("EMERGENCY_ALERT", payload);
    console.log(
      `[ALERT] Cảnh báo khẩn cấp từ ${socket.user.username} tới ${recipients.length} phiên`,
    );
    if (typeof ack === "function") {
      ack({
        success: true,
        recipients: recipients.length,
        cooldownMs: EMERGENCY_COOLDOWN_MS,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
  console.log(`API kích hoạt: GET http://localhost:${PORT}/api/trigger`);
  startMediaMTX();
  startScheduleWatcher();
});

function startMediaMTX() {
  const binDir = path.join(__dirname, ".bin");
  const isWindows = os.platform() === "win32";
  const mtxExeName = isWindows ? "mediamtx.exe" : "mediamtx";
  const mtxExe = path.join(binDir, mtxExeName);

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir);
  }

  writeMediaMTXConfigFile();

  if (fs.existsSync(mtxExe)) {
    if (isMediaMTXRunning()) {
      console.log("MediaMTX đã chạy, bỏ qua spawn mới.");
      return;
    }
    console.log("Đã tìm thấy MediaMTX. Đang chạy ngầm...");
    runMediaMTX(mtxExe, binDir);
  } else {
    console.log("Chưa có MediaMTX. Đang tải về...");
    let downloadCmd = "";
    if (isWindows) {
      const downloadUrl =
        "https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_windows_amd64.zip";
      const zipPath = path.join(binDir, "mediamtx.zip");
      const psCommand = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${zipPath}'; Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force; Remove-Item '${zipPath}'`;
      downloadCmd = `powershell -Command "${psCommand}"`;
    } else {
      const downloadUrl =
        "https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_amd64.tar.gz";
      const tarPath = path.join(binDir, "mediamtx.tar.gz");
      downloadCmd = `wget -O "${tarPath}" "${downloadUrl}" && tar -xzf "${tarPath}" -C "${binDir}" && rm "${tarPath}" && chmod +x "${mtxExe}"`;
    }

    exec(downloadCmd, (error) => {
      if (error) {
        console.error(`Lỗi tải MediaMTX: ${error.message}`);
        return;
      }
      console.log("Tải và giải nén MediaMTX thành công!");
      writeMediaMTXConfigFile();
      runMediaMTX(mtxExe, binDir);
    });
  }
}

function buildMediaMTXConfig() {
  const paths = config.cameras
    .filter((c) => c.enabled)
    .map((c) => `  ${c.path}:`)
    .join("\n");

  return `webrtcAddress: :8889
webrtcEncryption: no
webrtcAllowOrigin: '*'
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: [159.198.42.40]
webrtcICEHostNAT1To1IPs: [159.198.42.40]
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302

paths:
${paths || "  cam:"}
`;
}

function writeMediaMTXConfigFile() {
  const ymlPath = path.join(__dirname, ".bin", "mediamtx.yml");
  const binDir = path.join(__dirname, ".bin");
  try {
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir);
    }
    fs.writeFileSync(ymlPath, buildMediaMTXConfig());
  } catch (err) {
    console.warn("Không ghi được mediamtx.yml:", err.message);
  }
}

function isMediaMTXRunning() {
  try {
    const { execSync } = require("child_process");
    const out = execSync("ss -tlnp | grep ':8554 ' || true", {
      encoding: "utf8",
    });
    return out.includes(":8554");
  } catch (err) {
    return false;
  }
}

function runMediaMTX(exePath, cwd) {
  const mtxProcess = spawn(exePath, [], {
    cwd: cwd,
    detached: true,
    stdio: "ignore",
  });
  mtxProcess.unref();
  console.log("MediaMTX đang chạy ngầm ở cổng 8889 (WHEP) và 8554 (RTSP)");
}
