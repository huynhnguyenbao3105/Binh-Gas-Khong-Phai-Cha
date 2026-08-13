const socket = io();

const audioPlayer = document.getElementById('siren-audio');
const btnActivate = document.getElementById('btn-activate');
const btnActivateSettings = document.getElementById('btn-activate-settings');
const btnStop = document.getElementById('btn-stop');
const btnStopBanner = document.getElementById('btn-stop-banner');
const statusText = document.getElementById('status-text');
const logList = document.getElementById('log-list');
const btnClearLog = document.getElementById('btn-clear-log');
const btnChangePass = document.getElementById('btn-change-pass');
const btnChangePassSettings = document.getElementById('btn-change-pass-settings');
const btnAddCam = document.getElementById('btn-add-cam');
const btnAddCamSettings = document.getElementById('btn-add-cam-settings');
const cameraGrid = document.getElementById('camera-grid');
const camTree = document.getElementById('cam-tree');
const camModal = document.getElementById('cam-modal');
const camForm = document.getElementById('cam-form');
const camSidebar = document.getElementById('cam-sidebar');
const shell = document.querySelector('.shell');
const userMenu = document.getElementById('user-menu');
const alarmBanner = document.getElementById('alarm-banner');
const alarmBannerText = document.getElementById('alarm-banner-text');
const bellBadge = document.getElementById('bell-badge');
const clockText = document.getElementById('clock-text');
const camSearch = document.getElementById('cam-search');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

let isSystemActive = false;
let alarmTimeout;
let appConfig = { webrtcPort: 8889, rtspPort: 8554, cameras: [], me: null };
const players = new Map();
let currentLayout = 4;
let selectedCamId = null;
let activeGroup = null;
let searchQuery = '';
let alertCount = 0;
let collapsedGroups = new Set();
let currentUser = null;
let userList = [];

const ROLE_LABELS = {
    admin: 'Quản trị viên',
    operator: 'Vận hành',
    viewer: 'Chỉ xem'
};

function can(perm) {
    const role = currentUser && currentUser.role;
    if (perm === 'cameras' || perm === 'users') return role === 'admin';
    if (perm === 'siren') return role === 'admin' || role === 'operator';
    return Boolean(role);
}

function applyPermissions() {
    document.querySelectorAll('[data-perm]').forEach((el) => {
        el.classList.toggle('hidden', !can(el.dataset.perm));
    });
    players.forEach((player) => {
        if (player.els && player.els.edit) {
            player.els.edit.classList.toggle('hidden', !can('cameras'));
        }
    });
}

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function syncUserChrome() {
    if (!currentUser) return;
    const nameEl = document.getElementById('user-display-name');
    const avatarEl = document.getElementById('user-avatar');
    if (nameEl) nameEl.textContent = currentUser.name || currentUser.username;
    if (avatarEl) avatarEl.textContent = initials(currentUser.name || currentUser.username);
    applyPermissions();
}

function logMessage(msg, isAlert = false) {
    const li = document.createElement('li');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `<span class="log-msg">${msg}</span> <span class="log-time">${timeStr}</span>`;
    if (isAlert) li.className = 'alert-item';
    logList.insertBefore(li, logList.firstChild);
    logList.scrollTop = 0;
    while (logList.children.length > 40) {
        logList.removeChild(logList.lastChild);
    }
    if (isAlert) {
        alertCount += 1;
        bellBadge.textContent = String(alertCount);
        bellBadge.classList.remove('hidden');
    }
}

function waitIceGatheringComplete(pc, timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', onChange);
            resolve();
        }, timeoutMs);
        function onChange() {
            if (pc.iceGatheringState === 'complete') {
                clearTimeout(timer);
                pc.removeEventListener('icegatheringstatechange', onChange);
                resolve();
            }
        }
        pc.addEventListener('icegatheringstatechange', onChange);
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
        const card = document.createElement('article');
        card.className = 'cam-tile';
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
                        <button type="button" class="btn-edit ${can('cameras') ? '' : 'hidden'}" title="Cài đặt camera">
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 4v2M12 18v2M4.9 7.1l1.4 1.4M17.7 15.5l1.4 1.4M4.9 16.9l1.4-1.4M17.7 8.5l1.4-1.4"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        this.els = {
            card,
            title: card.querySelector('.cam-title'),
            liveDot: card.querySelector('.live-dot'),
            toggle: card.querySelector('.btn-toggle'),
            edit: card.querySelector('.btn-edit'),
            video: card.querySelector('video'),
            overlay: card.querySelector('.video-overlay'),
            box: card.querySelector('.video-box')
        };
        this.els.title.textContent = this.cfg.name;
        this.els.toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.connected || this.connecting) this.stop();
            else this.start();
        });
        this.els.edit.addEventListener('click', (e) => {
            e.stopPropagation();
            if (can('cameras')) openCamModal(this.cfg);
        });
        card.addEventListener('click', () => selectCamera(this.cfg.id, true));
        card.addEventListener('dblclick', () => {
            selectCamera(this.cfg.id, true);
            setLayout(1);
        });
        return card;
    }

    setStatus(text, kind) {
        this.els.liveDot.className = 'live-dot ' + kind;
        this.els.toggle.title = (this.connected || this.connecting) ? 'Ngắt kết nối' : 'Kết nối';
        this.els.toggle.innerHTML = (this.connected || this.connecting)
            ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M8 6.5v11l9-5.5-9-5.5Z"/></svg>';
    }

    setOverlay(text, show) {
        this.els.overlay.textContent = text;
        this.els.overlay.style.display = show ? 'flex' : 'none';
    }

    setAlert(on) {
        this.els.card.classList.toggle('alert', on);
    }

    hideIframe() {
        if (this.iframe) {
            this.iframe.style.display = 'none';
            this.iframe.src = '';
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
            try { await fetch(url, { method: 'DELETE' }); } catch (err) {}
        }
    }

    async start() {
        if (this.connecting || this.connected) return;
        const session = ++this.session;
        this.connecting = true;
        this.setStatus('Connecting', 'connecting');
        this.setOverlay('Đang kết nối WebRTC...', true);
        this.hideIframe();

        let loggedWaiting = false;
        while (session === this.session) {
            try {
                await this.startWhep(session);
                if (session !== this.session) return;
                this.setOverlay('', false);
                this.setStatus('WebRTC', 'online');
                this.connected = true;
                this.connecting = false;
                logMessage(`${this.cfg.name}: WebRTC đã kết nối`);
                return;
            } catch (err) {
                await this.cleanup();
                if (session !== this.session || (err && err.message === 'aborted')) return;
                if (err && err.noPublisher) {
                    this.setOverlay(`Chưa có luồng\nĐẩy RTSP tới:\n${this.publishUrl()}`, true);
                    this.setStatus('Chờ luồng', 'connecting');
                    if (!loggedWaiting) {
                        logMessage(`${this.cfg.name}: chờ publisher ${this.publishUrl()}`);
                        loggedWaiting = true;
                    }
                    try { await this.sleep(3000, session); } catch (e) { return; }
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
                if (session !== this.session) reject(new Error('aborted'));
                else resolve();
            }, ms);
        });
    }

    async startWhep(session) {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        this.pc = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });

        let settled = false;
        let markConnected = () => {};
        const iceConnected = new Promise((resolve, reject) => {
            this.timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('WHEP timeout'));
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
                if (pc.connectionState === 'connected') markConnected();
                if (pc.connectionState === 'failed' && !settled) {
                    settled = true;
                    if (this.timeoutId) {
                        clearTimeout(this.timeoutId);
                        this.timeoutId = null;
                    }
                    reject(new Error('ICE failed'));
                }
            };
            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                if (state === 'connected' || state === 'completed') markConnected();
                if (state === 'failed' && !settled) {
                    settled = true;
                    if (this.timeoutId) {
                        clearTimeout(this.timeoutId);
                        this.timeoutId = null;
                    }
                    reject(new Error('ICE failed'));
                }
            };
        });

        pc.ontrack = (event) => {
            this.els.video.srcObject = event.streams && event.streams[0]
                ? event.streams[0]
                : new MediaStream([event.track]);
            this.els.video.muted = true;
            this.els.video.play().catch(() => {});
            markConnected();
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIceGatheringComplete(pc);
        if (session !== this.session) throw new Error('aborted');

        const res = await fetch(this.whepUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp', 'Accept': 'application/sdp' },
            body: pc.localDescription.sdp
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error('WHEP HTTP ' + res.status);
            err.noPublisher = res.status === 404 || /no one is publishing/i.test(body);
            throw err;
        }
        const location = res.headers.get('Location');
        if (location) this.whepResourceUrl = new URL(location, this.whepUrl()).href;
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
        await iceConnected;
        if (session !== this.session) throw new Error('aborted');
    }

    async startPageFallback() {
        await this.cleanup();
        this.setOverlay('', false);
        if (!this.iframe) {
            this.iframe = document.createElement('iframe');
            this.iframe.allow = 'autoplay';
            this.els.box.appendChild(this.iframe);
        }
        this.iframe.src = this.pageUrl();
        this.iframe.style.display = 'block';
        this.setStatus('WebRTC', 'online');
        this.connected = true;
        this.connecting = false;
    }

    async stop() {
        this.session += 1;
        this.connecting = false;
        this.connected = false;
        await this.cleanup();
        this.hideIframe();
        this.setOverlay('Chưa kết nối', true);
        this.setStatus('Offline', 'offline');
        this.setAlert(false);
    }

    matchesSensor(sensorId) {
        if (!this.cfg.sensorIds || this.cfg.sensorIds.length === 0) return true;
        return this.cfg.sensorIds.includes(sensorId) || this.cfg.sensorIds.includes('*');
    }
}

function enabledCameras() {
    return (appConfig.cameras || []).filter((c) => c.enabled);
}

function destroyPlayers() {
    players.forEach((p) => p.stop());
    players.clear();
    cameraGrid.innerHTML = '';
}

function setLayout(size) {
    currentLayout = Number(size);
    cameraGrid.className = 'video-grid layout-' + currentLayout;
    document.querySelectorAll('.layout-btn').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.layout) === currentLayout);
    });
    renderGrid();
}

function renderGrid() {
    const list = enabledCameras();
    while (cameraGrid.firstChild) {
        cameraGrid.removeChild(cameraGrid.firstChild);
    }
    cameraGrid.className = 'video-grid layout-' + currentLayout;

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
        player.els.card.classList.toggle('selected', player.cfg.id === selectedCamId);
        cameraGrid.appendChild(player.root);
    });

    const placeholders = Math.max(0, currentLayout - visible.length);
    for (let i = 0; i < placeholders; i += 1) {
        const ph = document.createElement('div');
        ph.className = 'cam-placeholder';
        ph.innerHTML = '<span><svg viewBox="0 0 24 24"><rect x="4" y="7" width="12" height="10" rx="1.5"/><path d="M16 10.5 20 8v8l-4-2.5"/></svg>No signal</span>';
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
        activeGroup = first ? (first.group || 'Khu vực chính') : null;
    }
    renderGrid();
    renderCameraTree();
}

function renderCameraTree() {
    const list = enabledCameras();
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
        ? list.filter((c) => `${c.name} ${c.id} ${c.group || ''}`.toLowerCase().includes(q))
        : list;

    const groups = new Map();
    filtered.forEach((c) => {
        const g = c.group || 'Khu vực chính';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(c);
    });

    camTree.innerHTML = '';
    if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'tree-empty';
        empty.textContent = q ? 'Không tìm thấy camera' : 'Chưa có camera';
        camTree.appendChild(empty);
        return;
    }

    groups.forEach((cams, groupName) => {
        const section = document.createElement('div');
        section.className = 'tree-group' + (collapsedGroups.has(groupName) ? ' collapsed' : '');

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'tree-group-head' + (activeGroup === groupName ? ' active' : '');
        head.innerHTML = `
            <svg class="tree-chevron" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>
            <span>${groupName}</span>
            ${activeGroup === groupName ? '<span class="dot"></span>' : ''}
        `;
        head.addEventListener('click', () => {
            if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
            else collapsedGroups.add(groupName);
            activeGroup = groupName;
            renderCameraTree();
        });

        const items = document.createElement('div');
        items.className = 'tree-items';
        cams.forEach((cam) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'tree-item' + (selectedCamId === cam.id ? ' active' : '');
            item.innerHTML = `
                <svg viewBox="0 0 24 24"><rect x="4" y="7" width="12" height="10" rx="1.5"/><path d="M16 10.5 20 8v8l-4-2.5"/></svg>
                <span>${cam.name}</span>
            `;
            item.addEventListener('click', () => selectCamera(cam.id, true));
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
    if (cam) activeGroup = cam.group || 'Khu vực chính';
    players.forEach((player) => {
        player.els.card.classList.toggle('selected', player.cfg.id === id);
    });
    renderCameraTree();
    if (fromUser && currentLayout === 1) renderGrid();
    if (fromUser && window.innerWidth <= 960) closeMobileSidebar();
}

function setView(view) {
    if (view === 'users' && !can('users')) view = 'live';
    document.getElementById('view-live').classList.toggle('hidden', view !== 'live');
    document.getElementById('view-logs').classList.toggle('hidden', view !== 'logs');
    document.getElementById('view-settings').classList.toggle('hidden', view !== 'settings');
    document.getElementById('view-users').classList.toggle('hidden', view !== 'users');

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    if (view === 'users') loadUsers();
}

function tickClock() {
    const now = new Date();
    const date = now.toLocaleDateString('vi-VN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
    const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    clockText.textContent = `${date}  |  ${time}`;
}

function syncSirenButtons() {
    const labelOn = 'Còi đã bật';
    const labelOff = 'Bật còi báo';
    [btnActivate, btnActivateSettings].forEach((btn) => {
        if (!btn) return;
        btn.textContent = isSystemActive ? labelOn : labelOff;
        btn.classList.toggle('on', isSystemActive);
    });
}

function toggleSiren() {
    if (!isSystemActive) {
        audioPlayer.volume = 0;
        audioPlayer.play().then(() => {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            audioPlayer.volume = 1;
            isSystemActive = true;
            syncSirenButtons();
            logMessage('Còi báo động đã bật. Khi có gas sẽ kêu siren.');
        }).catch(() => {
            alert('Không phát được siren.mp3. Kiểm tra file trong thư mục public.');
        });
    } else {
        isSystemActive = false;
        syncSirenButtons();
        logMessage('Còi báo động đã tắt');
        if (!audioPlayer.paused) {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        }
    }
}

async function changePassword() {
    const currentPassword = prompt('Mật khẩu hiện tại:');
    if (currentPassword == null) return;
    const newPass = prompt('Mật khẩu mới:');
    if (!newPass) return;
    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword: newPass })
        });
        const data = await res.json();
        if (data.success) {
            alert('Đổi mật khẩu thành công');
        } else {
            alert(data.error || 'Đổi mật khẩu thất bại');
        }
    } catch (err) {
        alert('Lỗi kết nối máy chủ');
    }
}

function openCamModal(existing) {
    if (!can('cameras')) return;
    camForm.dataset.editId = existing ? existing.id : '';
    document.getElementById('cam-modal-title').textContent = existing ? 'Sửa camera' : 'Thêm camera';
    document.getElementById('cam-name').value = existing ? existing.name : '';
    document.getElementById('cam-group').value = existing && existing.group ? existing.group : 'Khu vực chính';
    document.getElementById('cam-id').value = existing ? existing.id : '';
    document.getElementById('cam-id').disabled = Boolean(existing);
    document.getElementById('cam-sensors').value = existing && existing.sensorIds ? existing.sensorIds.join(', ') : '';
    document.getElementById('cam-auto').checked = existing ? existing.autoConnect !== false : true;
    document.getElementById('cam-modal-delete').classList.toggle('hidden', !existing);
    camModal.classList.remove('hidden');
    userMenu.classList.add('hidden');
}

function closeCamModal() {
    camModal.classList.add('hidden');
}

async function loadConfig() {
    const res = await fetch('/api/config');
    if (res.status === 401) {
        window.location.href = '/login.html';
        return;
    }
    if (!res.ok) throw new Error('Không tải được cấu hình');
    appConfig = await res.json();
    currentUser = appConfig.me || null;
    syncUserChrome();
    renderCameras();
}

async function loadUsers() {
    if (!can('users')) return;
    const res = await fetch('/api/users');
    if (!res.ok) return;
    const data = await res.json();
    userList = data.users || [];
    renderUserTable();
}

function renderUserTable() {
    const body = document.getElementById('user-table-body');
    if (!body) return;
    body.innerHTML = '';
    userList.forEach((user) => {
        const tr = document.createElement('tr');
        if (user.enabled === false) tr.classList.add('disabled');
        tr.innerHTML = `
            <td></td>
            <td></td>
            <td><span class="role-pill role-${user.role}"></span></td>
            <td><button type="button" class="text-btn">Sửa</button></td>
        `;
        tr.children[0].textContent = user.name;
        tr.children[1].textContent = user.username;
        tr.querySelector('.role-pill').textContent = ROLE_LABELS[user.role] || user.role;
        tr.querySelector('button').addEventListener('click', () => openUserModal(user));
        body.appendChild(tr);
    });
}

function openUserModal(existing) {
    if (!can('users')) return;
    const form = document.getElementById('user-form');
    const modal = document.getElementById('user-modal');
    form.dataset.editId = existing ? existing.id : '';
    document.getElementById('user-modal-title').textContent = existing ? 'Sửa tài khoản' : 'Thêm tài khoản';
    document.getElementById('user-name').value = existing ? existing.name : '';
    document.getElementById('user-username').value = existing ? existing.username : '';
    document.getElementById('user-username').disabled = Boolean(existing);
    document.getElementById('user-role').value = existing ? existing.role : 'viewer';
    document.getElementById('user-password').value = '';
    document.getElementById('user-password').required = !existing;
    document.getElementById('user-pass-label').querySelector('input').placeholder = existing
        ? 'Để trống nếu giữ mật khẩu cũ'
        : 'Ít nhất 3 ký tự';
    document.getElementById('user-enabled').checked = existing ? existing.enabled !== false : true;
    document.getElementById('user-modal-delete').classList.toggle('hidden', !existing || existing.id === currentUser.id);
    modal.classList.remove('hidden');
    userMenu.classList.add('hidden');
}

function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
}

function openMobileSidebar() {
    camSidebar.classList.add('open');
    sidebarBackdrop.classList.remove('hidden');
}

function closeMobileSidebar() {
    camSidebar.classList.remove('open');
    sidebarBackdrop.classList.add('hidden');
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === 'soon') return;
        setView(view);
    });
});

document.querySelectorAll('.layout-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLayout(btn.dataset.layout));
});

document.getElementById('btn-collapse-sidebar').addEventListener('click', () => {
    if (window.innerWidth <= 960) {
        closeMobileSidebar();
        return;
    }
    shell.classList.toggle('sidebar-collapsed');
});

document.getElementById('btn-open-sidebar').addEventListener('click', openMobileSidebar);
sidebarBackdrop.addEventListener('click', closeMobileSidebar);

document.getElementById('btn-user').addEventListener('click', (e) => {
    e.stopPropagation();
    userMenu.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
    if (!userMenu.contains(e.target) && e.target.id !== 'btn-user') {
        userMenu.classList.add('hidden');
    }
});

document.getElementById('btn-bell').addEventListener('click', () => {
    alertCount = 0;
    bellBadge.classList.add('hidden');
    setView('logs');
});

document.getElementById('btn-logout').addEventListener('click', async () => {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (err) {}
    window.location.href = '/login.html';
});

document.getElementById('btn-add-user').addEventListener('click', () => openUserModal(null));
document.getElementById('user-modal-cancel').addEventListener('click', closeUserModal);
document.getElementById('user-modal').addEventListener('click', (e) => {
    if (e.target.id === 'user-modal') closeUserModal();
});
document.getElementById('user-modal-delete').addEventListener('click', async () => {
    const editId = document.getElementById('user-form').dataset.editId;
    if (!editId) return;
    if (!confirm('Xóa tài khoản này?')) return;
    const res = await fetch('/api/users/' + encodeURIComponent(editId), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Xóa tài khoản thất bại');
        return;
    }
    userList = data.users || [];
    closeUserModal();
    renderUserTable();
    logMessage('Đã xóa tài khoản');
});
document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = e.currentTarget.dataset.editId;
    const payload = {
        name: document.getElementById('user-name').value.trim(),
        username: document.getElementById('user-username').value.trim(),
        role: document.getElementById('user-role').value,
        enabled: document.getElementById('user-enabled').checked
    };
    const password = document.getElementById('user-password').value;
    if (password) payload.password = password;
    const res = await fetch(editId ? '/api/users/' + encodeURIComponent(editId) : '/api/users', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Lưu tài khoản thất bại');
        return;
    }
    userList = data.users || [];
    closeUserModal();
    renderUserTable();
    logMessage(editId ? 'Đã cập nhật tài khoản' : `Đã thêm tài khoản ${payload.username}`);
});

camSearch.addEventListener('input', () => {
    searchQuery = camSearch.value;
    renderCameraTree();
});

btnAddCam.addEventListener('click', () => openCamModal(null));
btnAddCamSettings.addEventListener('click', () => openCamModal(null));
document.getElementById('cam-modal-cancel').addEventListener('click', closeCamModal);
camModal.addEventListener('click', (e) => {
    if (e.target === camModal) closeCamModal();
});

document.getElementById('cam-modal-delete').addEventListener('click', async () => {
    const editId = camForm.dataset.editId;
    if (!editId) return;
    if (!confirm('Xóa camera này?')) return;
    const res = await fetch('/api/cameras/' + encodeURIComponent(editId), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Xóa camera thất bại');
        return;
    }
    appConfig = data.config;
    closeCamModal();
    renderCameras();
    logMessage('Đã xóa camera');
});

camForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
        name: document.getElementById('cam-name').value.trim(),
        group: document.getElementById('cam-group').value.trim() || 'Khu vực chính',
        id: document.getElementById('cam-id').value.trim(),
        path: document.getElementById('cam-id').value.trim(),
        autoConnect: document.getElementById('cam-auto').checked,
        enabled: true,
        sensorIds: document.getElementById('cam-sensors').value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    };
    const editId = camForm.dataset.editId;
    const res = await fetch(editId ? '/api/cameras/' + encodeURIComponent(editId) : '/api/cameras', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Lưu camera thất bại');
        return;
    }
    appConfig = data.config;
    closeCamModal();
    renderCameras();
    logMessage(editId ? 'Đã cập nhật camera' : `Đã thêm camera ${payload.name}`);
});

btnChangePass.addEventListener('click', changePassword);
btnChangePassSettings.addEventListener('click', changePassword);
btnClearLog.addEventListener('click', () => {
    logList.innerHTML = '';
});
btnActivate.addEventListener('click', toggleSiren);
btnActivateSettings.addEventListener('click', toggleSiren);
btnStop.addEventListener('click', () => stopAlarm());
btnStopBanner.addEventListener('click', () => stopAlarm());

socket.on('ALARM_TRIGGERED', (data) => {
    statusText.textContent = 'Cảnh báo gas';
    statusText.className = 'status-danger';
    if (can('siren')) btnStop.classList.remove('hidden');
    alarmBanner.classList.remove('hidden');
    alarmBannerText.textContent = `Phát hiện bình gas (${data.sensorId})`;
    logMessage(`Có bình gas (${data.sensorId})`, true);

    players.forEach((player) => {
        if (player.matchesSensor(data.sensorId)) {
            player.setAlert(true);
            if (!player.connected && !player.connecting) player.start();
        }
    });

    if (isSystemActive) {
        audioPlayer.currentTime = 0;
        audioPlayer.play().catch(() => {});
    } else {
        logMessage('Còi chưa bật nên không tự kêu');
    }

    if (alarmTimeout) clearTimeout(alarmTimeout);
    alarmTimeout = setTimeout(() => stopAlarm(), 5000);
});

function stopAlarm() {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    statusText.textContent = 'An toàn';
    statusText.className = 'status-safe';
    btnStop.classList.add('hidden');
    alarmBanner.classList.add('hidden');
    players.forEach((player) => player.setAlert(false));
    logMessage('Đã tắt báo động');
}

tickClock();
setInterval(tickClock, 1000);
setView('live');

document.addEventListener('DOMContentLoaded', () => {
    loadConfig().catch((err) => {
        console.error(err);
        logMessage('Không tải được danh sách camera');
    });
});
