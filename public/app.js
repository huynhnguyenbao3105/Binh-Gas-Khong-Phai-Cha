const socket = io();

const audioPlayer = document.getElementById("siren-audio");
const btnActivate = document.getElementById("btn-activate");
const btnActivateSettings = document.getElementById("btn-activate-settings");
const btnStop = document.getElementById("btn-stop");
const btnStopBanner = document.getElementById("btn-stop-banner");
const ROLE_LABELS = {
  admin: "Quản trị viên",
  operator: "Vận hành",
  viewer: "Chỉ xem",
};
const logList = document.getElementById("log-list");
const btnClearLog = document.getElementById("btn-clear-log");
const btnChangePass = document.getElementById("btn-change-pass");
const btnAddCam = document.getElementById("btn-add-cam");
const cameraGrid = document.getElementById("camera-grid");
const camTree = document.getElementById("cam-tree");
const camModal = document.getElementById("cam-modal");
const camForm = document.getElementById("cam-form");
const camSidebar = document.getElementById("cam-sidebar");
const shell = document.querySelector(".shell");
const userMenu = document.getElementById("user-menu");
const alarmBanner = document.getElementById("alarm-banner");
const alarmBannerText = document.getElementById("alarm-banner-text");
const bellBadge = document.getElementById("bell-badge");
const clockText = document.getElementById("clock-text");
const camSearch = document.getElementById("cam-search");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

let isSystemActive = true;
let audioUnlocked = false;
let alarmTimeout;
let appConfig = {
  webrtcPort: 8889,
  rtspPort: 8554,
  cameras: [],
  me: null,
  sounds: {},
  soundFiles: [],
};
let previewAudio = null;

const SOUND_EVENTS = [
  { id: "gas", label: "Cảm biến gas" },
  { id: "emergency", label: "Cảnh báo khẩn cấp" },
  { id: "meal", label: "11:45 dọn cơm" },
  { id: "home", label: "17:55 chuẩn bị về" },
];
const players = new Map();
let currentLayout = 4;
let selectedCamId = null;
let activeGroup = null;
let searchQuery = "";
let alertCount = 0;
let collapsedGroups = new Set();
let currentUser = null;
let mealSchedule = [];

const MEAL_DAY_LABELS = {
  mon: "Thứ 2",
  tue: "Thứ 3",
  wed: "Thứ 4",
  thu: "Thứ 5",
  fri: "Thứ 6",
  sat: "Thứ 7",
  sun: "Chủ nhật",
};

function can(perm) {
  const role = currentUser && currentUser.role;
  if (perm === "cameras") return role === "admin";
  if (perm === "siren") return role === "admin" || role === "operator";
  return Boolean(role);
}

function applyPermissions() {
  document.querySelectorAll("[data-perm]").forEach((el) => {
    el.classList.toggle("hidden", !can(el.dataset.perm));
  });
  players.forEach((player) => {
    if (player.els && player.els.edit) {
      player.els.edit.classList.toggle("hidden", !can("cameras"));
    }
  });
}

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function syncUserChrome() {
  if (!currentUser) return;
  const nameEl = document.getElementById("user-display-name");
  const avatarEl = document.getElementById("user-avatar");
  if (nameEl) nameEl.textContent = currentUser.name || currentUser.username;
  if (avatarEl)
    avatarEl.textContent = initials(currentUser.name || currentUser.username);
  const usernameInput = document.getElementById("account-username");
  if (usernameInput && !usernameInput.matches(":focus")) {
    usernameInput.value = currentUser.username || "";
  }
  const roleEl = document.getElementById("status-text");
  if (roleEl) {
    roleEl.textContent =
      ROLE_LABELS[currentUser.role] || currentUser.role || "";
    roleEl.className = "user-role";
  }
  applyPermissions();
}

function logMessage(msg, isAlert = false) {
  const li = document.createElement("li");
  const now = new Date();
  const timeStr = now.toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  li.innerHTML = `<span class="log-msg">${msg}</span> <span class="log-time">${timeStr}</span>`;
  if (isAlert) li.className = "alert-item";
  logList.insertBefore(li, logList.firstChild);
  logList.scrollTop = 0;
  while (logList.children.length > 40) {
    logList.removeChild(logList.lastChild);
  }
  if (isAlert) {
    alertCount += 1;
    bellBadge.textContent = String(alertCount);
    bellBadge.classList.remove("hidden");
    document.getElementById("btn-bell")?.classList.add("has-alert");
  }
}

function waitIceGatheringComplete(pc, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

class CameraPlayer {
  constructor(cfg) {
    this.cfg = cfg;
    this.session = 0;
    this.connecting = false;
    this.connected = false;
    this.pc = null;
    this.whepResourceUrl = null;
    this.timeoutId = null;
    this.root = this.render();
  }

  whepUrl() {
    return `http://${location.hostname}:${appConfig.webrtcPort}/${this.cfg.path}/whep`;
  }

  pageUrl() {
    return `http://${location.hostname}:${appConfig.webrtcPort}/${this.cfg.path}/`;
  }

  publishUrl() {
    return `rtsp://${location.hostname}:${appConfig.rtspPort}/${this.cfg.path}`;
  }

  render() {
    const card = document.createElement("article");
    card.className = "cam-tile";
    card.dataset.camId = this.cfg.id;
    card.innerHTML = `
            <div class="video-box">
                <video autoplay muted playsinline></video>
                <div class="video-overlay">Chưa kết nối</div>
                <div class="tile-chrome">
                    <div class="tile-live">
                        <span class="live-dot offline"></span>
                        <span class="cam-title"></span>
                    </div>
                    <div class="tile-actions">
                        <button type="button" class="btn-toggle" title="Kết nối">
                            <svg viewBox="0 0 24 24"><path d="M8 6.5v11l9-5.5-9-5.5Z"/></svg>
                        </button>
                        <button type="button" class="btn-edit ${can("cameras") ? "" : "hidden"}" title="Sửa camera">
                            <svg viewBox="0 0 24 24"><path d="M12.5 5.5 18.5 11.5"/><path d="M4 20h4.5L19 9.5 14.5 5 4 15.5V20Z"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
    this.els = {
      card,
      title: card.querySelector(".cam-title"),
      liveDot: card.querySelector(".live-dot"),
      toggle: card.querySelector(".btn-toggle"),
      edit: card.querySelector(".btn-edit"),
      video: card.querySelector("video"),
      overlay: card.querySelector(".video-overlay"),
      box: card.querySelector(".video-box"),
    };
    this.els.title.textContent = this.cfg.name;
    this.els.toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.connected || this.connecting) this.stop();
      else this.start();
    });
    this.els.edit.addEventListener("click", (e) => {
      e.stopPropagation();
      if (can("cameras")) openCamModal(this.cfg);
    });
    card.addEventListener("click", () => selectCamera(this.cfg.id, true));
    card.addEventListener("dblclick", () => {
      selectCamera(this.cfg.id, true);
      setLayout(1);
    });
    return card;
  }

  setStatus(text, kind) {
    this.els.liveDot.className = "live-dot " + kind;
    this.els.toggle.title =
      this.connected || this.connecting ? "Ngắt kết nối" : "Kết nối";
    this.els.toggle.innerHTML =
      this.connected || this.connecting
        ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 6.5v11l9-5.5-9-5.5Z"/></svg>';
  }

  setOverlay(text, show) {
    this.els.overlay.textContent = text;
    this.els.overlay.style.display = show ? "flex" : "none";
  }

  setAlert(on) {
    this.els.card.classList.toggle("alert", on);
  }

  hideIframe() {
    if (this.iframe) {
      this.iframe.style.display = "none";
      this.iframe.src = "";
    }
  }

  async cleanup() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try {
        pc.getReceivers().forEach((r) => r.track && r.track.stop());
        pc.close();
      } catch (err) {
        console.warn(err);
      }
    }
    this.els.video.srcObject = null;
    if (this.whepResourceUrl) {
      const url = this.whepResourceUrl;
      this.whepResourceUrl = null;
      try {
        await fetch(url, { method: "DELETE" });
      } catch (err) {}
    }
  }

  async start() {
    if (this.connecting || this.connected) return;
    const session = ++this.session;
    this.connecting = true;
    this.setStatus("Connecting", "connecting");
    this.setOverlay("Đang kết nối WebRTC...", true);
    this.hideIframe();

    let loggedWaiting = false;
    while (session === this.session) {
      try {
        await this.startWhep(session);
        if (session !== this.session) return;
        this.setOverlay("", false);
        this.setStatus("WebRTC", "online");
        this.connected = true;
        this.connecting = false;
        logMessage(`${this.cfg.name}: WebRTC đã kết nối`);
        return;
      } catch (err) {
        await this.cleanup();
        if (session !== this.session || (err && err.message === "aborted"))
          return;
        if (err && err.noPublisher) {
          this.setOverlay(
            `Chưa có luồng\nĐẩy RTSP tới:\n${this.publishUrl()}`,
            true,
          );
          this.setStatus("Chờ luồng", "connecting");
          if (!loggedWaiting) {
            logMessage(`${this.cfg.name}: chờ publisher ${this.publishUrl()}`);
            loggedWaiting = true;
          }
          try {
            await this.sleep(3000, session);
          } catch (e) {
            return;
          }
          continue;
        }
        logMessage(`${this.cfg.name}: WHEP lỗi, dùng player MediaMTX`);
        await this.startPageFallback();
        return;
      }
    }
  }

  sleep(ms, session) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (session !== this.session) reject(new Error("aborted"));
        else resolve();
      }, ms);
    });
  }

  async startWhep(session) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });

    let settled = false;
    let markConnected = () => {};
    const iceConnected = new Promise((resolve, reject) => {
      this.timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("WHEP timeout"));
        }
      }, 15000);
      markConnected = () => {
        if (settled) return;
        settled = true;
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        resolve();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") markConnected();
        if (pc.connectionState === "failed" && !settled) {
          settled = true;
          if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
          }
          reject(new Error("ICE failed"));
        }
      };
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === "connected" || state === "completed") markConnected();
        if (state === "failed" && !settled) {
          settled = true;
          if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
          }
          reject(new Error("ICE failed"));
        }
      };
    });

    pc.ontrack = (event) => {
      this.els.video.srcObject =
        event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);
      this.els.video.muted = true;
      this.els.video.play().catch(() => {});
      markConnected();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc);
    if (session !== this.session) throw new Error("aborted");

    const res = await fetch(this.whepUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error("WHEP HTTP " + res.status);
      err.noPublisher =
        res.status === 404 || /no one is publishing/i.test(body);
      throw err;
    }
    const location = res.headers.get("Location");
    if (location) this.whepResourceUrl = new URL(location, this.whepUrl()).href;
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    await iceConnected;
    if (session !== this.session) throw new Error("aborted");
  }

  async startPageFallback() {
    await this.cleanup();
    this.setOverlay("", false);
    if (!this.iframe) {
      this.iframe = document.createElement("iframe");
      this.iframe.allow = "autoplay";
      this.els.box.appendChild(this.iframe);
    }
    this.iframe.src = this.pageUrl();
    this.iframe.style.display = "block";
    this.setStatus("WebRTC", "online");
    this.connected = true;
    this.connecting = false;
  }

  async stop() {
    this.session += 1;
    this.connecting = false;
    this.connected = false;
    await this.cleanup();
    this.hideIframe();
    this.setOverlay("Chưa kết nối", true);
    this.setStatus("Offline", "offline");
    this.setAlert(false);
  }

  matchesSensor(sensorId) {
    if (!this.cfg.sensorIds || this.cfg.sensorIds.length === 0) return true;
    return (
      this.cfg.sensorIds.includes(sensorId) || this.cfg.sensorIds.includes("*")
    );
  }
}

function enabledCameras() {
  return (appConfig.cameras || []).filter((c) => c.enabled);
}

function destroyPlayers() {
  players.forEach((p) => p.stop());
  players.clear();
  cameraGrid.innerHTML = "";
}

function setLayout(size) {
  currentLayout = Number(size);
  cameraGrid.className = "video-grid layout-" + currentLayout;
  document.querySelectorAll(".layout-btn").forEach((btn) => {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.layout) === currentLayout,
    );
  });
  renderGrid();
}

function renderGrid() {
  const list = enabledCameras();
  while (cameraGrid.firstChild) {
    cameraGrid.removeChild(cameraGrid.firstChild);
  }
  cameraGrid.className = "video-grid layout-" + currentLayout;

  let visible = list;
  if (currentLayout === 1) {
    const focused = list.find((c) => c.id === selectedCamId) || list[0];
    visible = focused ? [focused] : [];
  } else if (list.length > currentLayout) {
    let start = list.findIndex((c) => c.id === selectedCamId);
    if (start < 0) start = 0;
    start = Math.min(start, list.length - currentLayout);
    visible = list.slice(start, start + currentLayout);
  }

  visible.forEach((cfg) => {
    let player = players.get(cfg.id);
    if (!player) {
      player = new CameraPlayer(cfg);
      players.set(cfg.id, player);
      if (cfg.autoConnect) setTimeout(() => player.start(), 400);
    } else {
      player.cfg = cfg;
      player.els.title.textContent = cfg.name;
    }
    player.els.card.classList.toggle(
      "selected",
      player.cfg.id === selectedCamId,
    );
    cameraGrid.appendChild(player.root);
  });

  const placeholders = Math.max(0, currentLayout - visible.length);
  for (let i = 0; i < placeholders; i += 1) {
    const ph = document.createElement("div");
    ph.className = "cam-placeholder";
    ph.innerHTML =
      '<span><svg viewBox="0 0 24 24"><rect x="4" y="7" width="12" height="10" rx="1.5"/><path d="M16 10.5 20 8v8l-4-2.5"/></svg>No signal</span>';
    cameraGrid.appendChild(ph);
  }
}

function renderCameras() {
  const list = enabledCameras();
  const keep = new Set(list.map((c) => c.id));
  players.forEach((player, id) => {
    if (!keep.has(id)) {
      player.stop();
      players.delete(id);
    } else {
      const cfg = list.find((c) => c.id === id);
      player.cfg = cfg;
      player.els.title.textContent = cfg.name;
    }
  });
  if (!selectedCamId || !keep.has(selectedCamId)) {
    selectedCamId = list[0] ? list[0].id : null;
  }
  if (!activeGroup) {
    const first = list[0];
    activeGroup = first ? first.group || "Khu vực chính" : null;
  }
  renderGrid();
  renderCameraTree();
}

function renderCameraTree() {
  const list = enabledCameras();
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? list.filter((c) =>
        `${c.name} ${c.id} ${c.group || ""}`.toLowerCase().includes(q),
      )
    : list;

  const groups = new Map();
  filtered.forEach((c) => {
    const g = c.group || "Khu vực chính";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  });

  camTree.innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "tree-empty";
    empty.textContent = q ? "Không tìm thấy camera" : "Chưa có camera";
    camTree.appendChild(empty);
    return;
  }

  groups.forEach((cams, groupName) => {
    const section = document.createElement("div");
    section.className =
      "tree-group" + (collapsedGroups.has(groupName) ? " collapsed" : "");

    const head = document.createElement("button");
    head.type = "button";
    head.className =
      "tree-group-head" + (activeGroup === groupName ? " active" : "");
    head.innerHTML = `
            <svg class="tree-chevron" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>
            <span>${groupName}</span>
            ${activeGroup === groupName ? '<span class="dot"></span>' : ""}
        `;
    head.addEventListener("click", () => {
      if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
      else collapsedGroups.add(groupName);
      activeGroup = groupName;
      renderCameraTree();
    });

    const items = document.createElement("div");
    items.className = "tree-items";
    cams.forEach((cam) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "tree-item" + (selectedCamId === cam.id ? " active" : "");
      item.innerHTML = `
                <svg viewBox="0 0 24 24"><rect x="4" y="7" width="12" height="10" rx="1.5"/><path d="M16 10.5 20 8v8l-4-2.5"/></svg>
                <span>${cam.name}</span>
            `;
      item.addEventListener("click", () => selectCamera(cam.id, true));
      items.appendChild(item);
    });

    section.appendChild(head);
    section.appendChild(items);
    camTree.appendChild(section);
  });
}

function selectCamera(id, fromUser) {
  selectedCamId = id;
  const cam = enabledCameras().find((c) => c.id === id);
  if (cam) activeGroup = cam.group || "Khu vực chính";
  players.forEach((player) => {
    player.els.card.classList.toggle("selected", player.cfg.id === id);
  });
  renderCameraTree();
  if (fromUser && currentLayout === 1) renderGrid();
  if (fromUser && window.innerWidth <= 960) closeMobileSidebar();
}

function setView(view) {
  document
    .getElementById("view-live")
    .classList.toggle("hidden", view !== "live");
  document
    .getElementById("view-logs")
    .classList.toggle("hidden", view !== "logs");
  document
    .getElementById("view-meals")
    .classList.toggle("hidden", view !== "meals");
  document
    .getElementById("view-settings")
    .classList.toggle("hidden", view !== "settings");

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  if (view === "meals") renderMealSchedule();
  if (view === "settings") renderSoundSettings();
}

function tickClock() {
  const now = new Date();
  const date = now.toLocaleDateString("vi-VN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = now.toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  clockText.textContent = `${date}  |  ${time}`;
}

function syncSirenButtons() {
  const labelOn = "Còi đã bật";
  const labelOff = "Bật còi báo";
  if (btnActivate) {
    btnActivate.title = isSystemActive ? labelOn : labelOff;
    btnActivate.classList.toggle("on", isSystemActive);
  }
  if (btnActivateSettings) {
    btnActivateSettings.textContent = isSystemActive ? labelOn : labelOff;
    btnActivateSettings.classList.toggle("on", isSystemActive);
  }
}

function soundUrl(file) {
  if (!file) return "";
  return "/sounds/" + encodeURIComponent(file);
}

function assignedSounds(kind) {
  const value = appConfig.sounds && appConfig.sounds[kind];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function pickSound(kind) {
  const list = assignedSounds(kind);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list[Math.floor(Math.random() * list.length)];
}

function stopPreviewSound() {
  if (!previewAudio) return;
  previewAudio.pause();
  previewAudio.src = "";
  previewAudio = null;
}

function playAlertSound(kind) {
  if (!isSystemActive || !audioPlayer) return;
  const file = pickSound(kind);
  if (!file) return;
  stopPreviewSound();
  audioPlayer.src = soundUrl(file);
  audioPlayer.loop = true;
  audioPlayer.volume = 1;
  audioPlayer.currentTime = 0;
  audioPlayer.play().catch(() => {
    audioUnlocked = false;
    unlockAudio();
  });
}

function previewSound(file) {
  if (!file) return;
  stopPreviewSound();
  if (audioPlayer && !audioPlayer.paused) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
  }
  previewAudio = new Audio(soundUrl(file));
  previewAudio.play().catch(() => unlockAudio());
}

function prettySoundName(file) {
  if (!file) return "Không phát";
  const raw = file
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : file;
}

function closeSoundPickers(except) {
  document.querySelectorAll(".sound-picker.open").forEach((el) => {
    if (el !== except) el.classList.remove("open");
  });
}

function getPickerValues(picker) {
  try {
    const list = JSON.parse(picker.dataset.values || "[]");
    return Array.isArray(list) ? list.filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

function soundPickerLabel(list) {
  if (!list.length) return "Không phát";
  if (list.length === 1) return prettySoundName(list[0]);
  return `${list.length} âm thanh · random`;
}

function setSoundPickerValues(picker, values) {
  const list = Array.from(new Set((values || []).filter(Boolean)));
  picker.dataset.values = JSON.stringify(list);
  const label = picker.querySelector(".sound-picker-btn span");
  if (label) label.textContent = soundPickerLabel(list);
  picker.querySelectorAll(".sound-option").forEach((btn) => {
    const value = btn.dataset.value || "";
    const active = value ? list.includes(value) : list.length === 0;
    btn.classList.toggle("active", active);
  });
}

function toggleSoundPickerValue(picker, value) {
  if (!value) {
    setSoundPickerValues(picker, []);
    saveSoundAssignments();
    return;
  }
  const list = getPickerValues(picker);
  const next = list.includes(value)
    ? list.filter((item) => item !== value)
    : list.concat(value);
  setSoundPickerValues(picker, next);
  saveSoundAssignments();
}

function createSoundPicker(eventId, selected, files) {
  const picker = document.createElement("div");
  picker.className = "sound-picker";
  picker.dataset.event = eventId;
  const selectedList = Array.isArray(selected)
    ? selected
    : selected
      ? [selected]
      : [];

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sound-picker-btn";
  btn.innerHTML = `<span></span><svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !picker.classList.contains("open");
    closeSoundPickers(picker);
    picker.classList.toggle("open", open);
  });

  const menu = document.createElement("div");
  menu.className = "sound-picker-menu";
  const options = [{ value: "", label: "Không phát" }].concat(
    files.map((file) => ({ value: file, label: prettySoundName(file) })),
  );
  options.forEach((item) => {
    const opt = document.createElement("div");
    opt.className = "sound-option";
    opt.dataset.value = item.value;
    const mark = document.createElement("i");
    mark.className = "sound-check";
    const text = document.createElement("span");
    text.textContent = item.label;
    opt.append(mark, text);
    if (item.value) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "sound-option-play";
      play.title = "Nghe thử";
      play.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M8 6.5v11l9-5.5-9-5.5Z"/></svg>';
      play.addEventListener("click", (e) => {
        e.stopPropagation();
        previewSound(item.value);
      });
      opt.appendChild(play);
    }
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSoundPickerValue(picker, item.value);
      if (!item.value) picker.classList.remove("open");
    });
    menu.appendChild(opt);
  });

  picker.append(btn, menu);
  setSoundPickerValues(picker, selectedList);
  return picker;
}

function renderSoundSettings() {
  const body = document.getElementById("sound-table-body");
  if (!body) return;
  const editable = can("siren");
  const files = appConfig.soundFiles || [];
  const assignments = appConfig.sounds || {};
  body.innerHTML = "";
  SOUND_EVENTS.forEach((event) => {
    const tr = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = event.label;
    const selectCell = document.createElement("td");
    const actionCell = document.createElement("td");
    if (editable) {
      const picker = createSoundPicker(
        event.id,
        assignments[event.id] || [],
        files,
      );
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "sound-play-btn";
      playBtn.title = "Nghe thử";
      playBtn.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M8 6.5v11l9-5.5-9-5.5Z"/></svg><span>Nghe</span>';
      playBtn.addEventListener("click", () => {
        const list = getPickerValues(picker);
        if (!list.length) return;
        previewSound(
          list.length === 1
            ? list[0]
            : list[Math.floor(Math.random() * list.length)],
        );
      });
      selectCell.appendChild(picker);
      actionCell.appendChild(playBtn);
    } else {
      const list = Array.isArray(assignments[event.id])
        ? assignments[event.id]
        : assignments[event.id]
          ? [assignments[event.id]]
          : [];
      selectCell.textContent = soundPickerLabel(list);
      if (!list.length) selectCell.classList.add("muted-cell");
    }
    tr.append(labelCell, selectCell, actionCell);
    body.appendChild(tr);
  });
}

async function saveSoundAssignments() {
  if (!can("siren")) return;
  const sounds = {};
  SOUND_EVENTS.forEach((event) => {
    const picker = document.querySelector(
      `.sound-picker[data-event="${event.id}"]`,
    );
    sounds[event.id] = picker ? getPickerValues(picker) : [];
  });
  const res = await fetch("/api/sounds", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sounds }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    alert((data && data.error) || "Lưu âm thanh thất bại");
    return;
  }
  appConfig.sounds = data.sounds || sounds;
  appConfig.soundFiles = data.soundFiles || appConfig.soundFiles;
  logMessage("Đã lưu âm thanh thông báo");
}

function unlockAudio() {
  if (audioUnlocked || !audioPlayer) return Promise.resolve();
  const file =
    pickSound("emergency") ||
    pickSound("gas") ||
    (appConfig.soundFiles && appConfig.soundFiles[0]) ||
    "";
  if (file && !audioPlayer.src) audioPlayer.src = soundUrl(file);
  if (!audioPlayer.src) return Promise.resolve();
  audioPlayer.volume = 0;
  return audioPlayer
    .play()
    .then(() => {
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
      audioPlayer.volume = 1;
      audioUnlocked = true;
    })
    .catch(() => {});
}

function toggleSiren() {
  if (!isSystemActive) {
    unlockAudio().then(() => {
      isSystemActive = true;
      syncSirenButtons();
      logMessage("Còi báo động đã bật. Khi có gas sẽ kêu siren.");
    });
  } else {
    isSystemActive = false;
    syncSirenButtons();
    logMessage("Còi báo động đã tắt");
    if (!audioPlayer.paused) {
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
    }
  }
}

function openAccountSettings() {
  userMenu.classList.add("hidden");
  const modal = document.getElementById("account-modal");
  const input = document.getElementById("account-username");
  const current = document.getElementById("account-current");
  const next = document.getElementById("account-new");
  if (input) input.value = (currentUser && currentUser.username) || "";
  if (current) current.value = "";
  if (next) next.value = "";
  modal.classList.remove("hidden");
  input?.focus();
  input?.select();
}

function closeAccountSettings() {
  document.getElementById("account-modal").classList.add("hidden");
}

async function saveAccount(e) {
  e.preventDefault();
  const username = document.getElementById("account-username").value.trim();
  const currentPassword = document.getElementById("account-current").value;
  const newPassword = document.getElementById("account-new").value;
  try {
    const res = await fetch("/api/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.error || "Lưu tài khoản thất bại");
      return;
    }
    currentUser = data.user || currentUser;
    if (appConfig) appConfig.me = currentUser;
    document.getElementById("account-current").value = "";
    document.getElementById("account-new").value = "";
    syncUserChrome();
    closeAccountSettings();
    logMessage("Đã cập nhật tài khoản");
  } catch (err) {
    alert("Lỗi kết nối máy chủ");
  }
}

function todayMealDay() {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
}

function canEditMeals() {
  return can("siren");
}

function renderMealSchedule() {
  const body = document.getElementById("meal-table-body");
  const saveBtn = document.getElementById("btn-save-meals");
  if (!body) return;
  const editable = canEditMeals();
  if (saveBtn) saveBtn.classList.toggle("hidden", !editable);
  const today = todayMealDay();
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const rows = days.map((day) => {
    const item = mealSchedule.find((row) => row.day === day) || {
      day,
      name1: "",
      name2: "",
    };
    return { ...item, day };
  });
  body.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.day === today) tr.classList.add("today");
    const dayCell = document.createElement("td");
    dayCell.innerHTML = `<strong>${MEAL_DAY_LABELS[row.day] || row.day}</strong>`;
    if (row.day === today) {
      const badge = document.createElement("span");
      badge.className = "today-badge";
      badge.textContent = "Hôm nay";
      dayCell.appendChild(badge);
    }
    const name1Cell = document.createElement("td");
    const name2Cell = document.createElement("td");
    if (editable) {
      [name1Cell, name2Cell].forEach((cell, idx) => {
        const field = idx === 0 ? "name1" : "name2";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "meal-input";
        input.dataset.day = row.day;
        input.dataset.field = field;
        input.maxLength = 80;
        input.placeholder = "Tên người dọn";
        input.value = row[field] || "";
        cell.appendChild(input);
      });
    } else {
      name1Cell.textContent = row.name1 || "Chưa phân công";
      name2Cell.textContent = row.name2 || "Chưa phân công";
      if (!row.name1) name1Cell.classList.add("muted-cell");
      if (!row.name2) name2Cell.classList.add("muted-cell");
    }
    tr.append(dayCell, name1Cell, name2Cell);
    body.appendChild(tr);
  });
}

async function saveMealSchedule() {
  if (!canEditMeals()) return;
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => {
    const name1Input = document.querySelector(
      `.meal-input[data-day="${day}"][data-field="name1"]`,
    );
    const name2Input = document.querySelector(
      `.meal-input[data-day="${day}"][data-field="name2"]`,
    );
    return {
      day,
      name1: name1Input ? name1Input.value.trim() : "",
      name2: name2Input ? name2Input.value.trim() : "",
    };
  });
  const res = await fetch("/api/meal-schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    alert((data && data.error) || "Lưu lịch thất bại");
    return;
  }
  mealSchedule = data.mealSchedule || days;
  renderMealSchedule();
  logMessage("Đã cập nhật lịch dọn cơm");
}

function openCamModal(existing) {
  if (!can("cameras")) return;
  camForm.dataset.editId = existing ? existing.id : "";
  document.getElementById("cam-modal-title").textContent = existing
    ? "Sửa camera"
    : "Thêm camera";
  document.getElementById("cam-name").value = existing ? existing.name : "";
  document.getElementById("cam-group").value =
    existing && existing.group ? existing.group : "Khu vực chính";
  document.getElementById("cam-id").value = existing ? existing.id : "";
  document.getElementById("cam-id").disabled = Boolean(existing);
  document.getElementById("cam-sensors").value =
    existing && existing.sensorIds ? existing.sensorIds.join(", ") : "";
  document.getElementById("cam-auto").checked = existing
    ? existing.autoConnect !== false
    : true;
  document
    .getElementById("cam-modal-delete")
    .classList.toggle("hidden", !existing);
  camModal.classList.remove("hidden");
  userMenu.classList.add("hidden");
}

function closeCamModal() {
  camModal.classList.add("hidden");
}

async function loadConfig() {
  const res = await fetch("/api/config");
  if (res.status === 401) {
    window.location.href = "/login.html";
    return;
  }
  if (!res.ok) throw new Error("Không tải được cấu hình");
  appConfig = await res.json();
  currentUser = appConfig.me || null;
  mealSchedule = appConfig.mealSchedule || [];
  appConfig.sounds = appConfig.sounds || {};
  appConfig.soundFiles = appConfig.soundFiles || [];
  syncUserChrome();
  renderCameras();
  renderMealSchedule();
  renderSoundSettings();
}

function openMobileSidebar() {
  camSidebar.classList.add("open");
  sidebarBackdrop.classList.remove("hidden");
}

function closeMobileSidebar() {
  camSidebar.classList.remove("open");
  sidebarBackdrop.classList.add("hidden");
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (view === "soon") return;
    setView(view);
  });
});

document.querySelectorAll(".layout-btn").forEach((btn) => {
  btn.addEventListener("click", () => setLayout(btn.dataset.layout));
});

document
  .getElementById("btn-collapse-sidebar")
  .addEventListener("click", () => {
    if (window.innerWidth <= 960) {
      closeMobileSidebar();
      return;
    }
    shell.classList.toggle("sidebar-collapsed");
  });

document
  .getElementById("btn-open-sidebar")
  .addEventListener("click", openMobileSidebar);
sidebarBackdrop.addEventListener("click", closeMobileSidebar);

document.getElementById("btn-user").addEventListener("click", (e) => {
  e.stopPropagation();
  userMenu.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!userMenu.contains(e.target) && e.target.id !== "btn-user") {
    userMenu.classList.add("hidden");
  }
  if (!e.target.closest(".sound-picker")) closeSoundPickers();
});

const emergencyPopup = document.getElementById("emergency-popup");
let sendingAlert = false;

function sendEmergencyAlert() {
  if (sendingAlert) return;
  sendingAlert = true;
  alertCount = 0;
  bellBadge.classList.add("hidden");
  document.getElementById("btn-bell")?.classList.remove("has-alert");
  userMenu.classList.add("hidden");
  socket.timeout(5000).emit("EMERGENCY_ALERT", {}, (err, ack) => {
    sendingAlert = false;
    if (err) {
      logMessage("Không gửi được cảnh báo. Kiểm tra kết nối.");
      return;
    }
    const n = ack && ack.recipients ? ack.recipients : 0;
    logMessage(
      n
        ? `Đã gửi cảnh báo khẩn cấp tới ${n} phiên`
        : "Đã gửi cảnh báo khẩn cấp",
    );
  });
}

function showEmergencyPopup(data) {
  const title = (data && data.title) || "Cảnh báo khẩn cấp";
  const message = (data && data.message) || "Bình gas đang di chuyển";
  const when =
    data && data.timestamp
      ? new Date(data.timestamp).toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "";
  document.getElementById("emergency-title").textContent = title;
  document.getElementById("emergency-text").textContent = message;
  document.getElementById("emergency-time").textContent = when
    ? `Lúc ${when}`
    : "";
  emergencyPopup.classList.remove("hidden");
  logMessage(`${title}: ${message}`, true);
  playAlertSound((data && data.kind) || "emergency");
}

function ackEmergencyPopup() {
  emergencyPopup.classList.add("hidden");
  stopPreviewSound();
  if (alarmBanner.classList.contains("hidden")) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
  }
}

document
  .getElementById("btn-bell")
  .addEventListener("click", sendEmergencyAlert);
document
  .getElementById("emergency-ack")
  .addEventListener("click", ackEmergencyPopup);

socket.on("EMERGENCY_ALERT", (data) => {
  showEmergencyPopup(data);
});

socket.on("SCHEDULED_ALERT", (data) => {
  showEmergencyPopup(data);
});

socket.on("MEAL_SCHEDULE_UPDATED", (data) => {
  mealSchedule = (data && data.mealSchedule) || mealSchedule;
  renderMealSchedule();
});

socket.on("SOUNDS_UPDATED", (data) => {
  appConfig.sounds = (data && data.sounds) || appConfig.sounds;
  appConfig.soundFiles = (data && data.soundFiles) || appConfig.soundFiles;
  renderSoundSettings();
});

document
  .getElementById("btn-save-meals")
  .addEventListener("click", saveMealSchedule);

document.getElementById("btn-logout").addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (err) {}
  window.location.href = "/login.html";
});

camSearch.addEventListener("input", () => {
  searchQuery = camSearch.value;
  renderCameraTree();
});

btnAddCam.addEventListener("click", () => openCamModal(null));
document
  .getElementById("cam-modal-cancel")
  .addEventListener("click", closeCamModal);
camModal.addEventListener("click", (e) => {
  if (e.target === camModal) closeCamModal();
});

document
  .getElementById("cam-modal-delete")
  .addEventListener("click", async () => {
    const editId = camForm.dataset.editId;
    if (!editId) return;
    if (!confirm("Xóa camera này?")) return;
    const res = await fetch("/api/cameras/" + encodeURIComponent(editId), {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Xóa camera thất bại");
      return;
    }
    appConfig = data.config;
    closeCamModal();
    renderCameras();
    logMessage("Đã xóa camera");
  });

camForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: document.getElementById("cam-name").value.trim(),
    group: document.getElementById("cam-group").value.trim() || "Khu vực chính",
    id: document.getElementById("cam-id").value.trim(),
    path: document.getElementById("cam-id").value.trim(),
    autoConnect: document.getElementById("cam-auto").checked,
    enabled: true,
    sensorIds: document
      .getElementById("cam-sensors")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const editId = camForm.dataset.editId;
  const res = await fetch(
    editId ? "/api/cameras/" + encodeURIComponent(editId) : "/api/cameras",
    {
      method: editId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Lưu camera thất bại");
    return;
  }
  appConfig = data.config;
  closeCamModal();
  renderCameras();
  logMessage(editId ? "Đã cập nhật camera" : `Đã thêm camera ${payload.name}`);
});

btnChangePass.addEventListener("click", openAccountSettings);
document.getElementById("account-form").addEventListener("submit", saveAccount);
document
  .getElementById("account-modal-cancel")
  .addEventListener("click", closeAccountSettings);
document.getElementById("account-modal").addEventListener("click", (e) => {
  if (e.target.id === "account-modal") closeAccountSettings();
});
btnClearLog.addEventListener("click", () => {
  logList.innerHTML = "";
});
btnActivate.addEventListener("click", toggleSiren);
btnActivateSettings.addEventListener("click", toggleSiren);
btnStop.addEventListener("click", () => stopAlarm());
btnStopBanner.addEventListener("click", () => stopAlarm());

socket.on("ALARM_TRIGGERED", (data) => {
  if (can("siren")) btnStop.classList.remove("hidden");
  alarmBanner.classList.remove("hidden");
  alarmBannerText.textContent = `Phát hiện bình gas (${data.sensorId})`;
  logMessage(`Có bình gas (${data.sensorId})`, true);

  players.forEach((player) => {
    if (player.matchesSensor(data.sensorId)) {
      player.setAlert(true);
      if (!player.connected && !player.connecting) player.start();
    }
  });

  if (isSystemActive) {
    playAlertSound("gas");
  } else {
    logMessage("Còi chưa bật nên không tự kêu");
  }

  if (alarmTimeout) clearTimeout(alarmTimeout);
  alarmTimeout = setTimeout(() => stopAlarm(), 5000);
});

function stopAlarm() {
  stopPreviewSound();
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  btnStop.classList.add("hidden");
  alarmBanner.classList.add("hidden");
  players.forEach((player) => player.setAlert(false));
  logMessage("Đã tắt báo động");
}

tickClock();
setInterval(tickClock, 1000);
setView("live");

function showSirenTip() {
  const tip = document.getElementById("siren-tip");
  if (!tip || !can("siren")) return;
  tip.classList.remove("hidden");
  const hide = () => tip.classList.add("hidden");
  setTimeout(hide, 2000);
  tip.addEventListener("click", hide, { once: true });
  if (btnActivate) btnActivate.addEventListener("click", hide, { once: true });
}

document.addEventListener("DOMContentLoaded", () => {
  syncSirenButtons();
  const unlockOnce = () => {
    unlockAudio();
    document.removeEventListener("pointerdown", unlockOnce);
    document.removeEventListener("keydown", unlockOnce);
  };
  document.addEventListener("pointerdown", unlockOnce);
  document.addEventListener("keydown", unlockOnce);
  loadConfig()
    .then(() => {
      showSirenTip();
    })
    .catch((err) => {
      console.error(err);
      logMessage("Không tải được danh sách camera");
    });
});
