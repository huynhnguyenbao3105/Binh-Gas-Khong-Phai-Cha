const socket = io();

const audioPlayer = document.getElementById('siren-audio');
const btnActivate = document.getElementById('btn-activate');
const btnStop = document.getElementById('btn-stop');
const statusText = document.getElementById('status-text');
const logList = document.getElementById('log-list');
const btnClearLog = document.getElementById('btn-clear-log');
const btnChangePass = document.getElementById('btn-change-pass');
const btnAddCam = document.getElementById('btn-add-cam');
const cameraGrid = document.getElementById('camera-grid');
const camModal = document.getElementById('cam-modal');
const camForm = document.getElementById('cam-form');

let isSystemActive = false;
let alarmTimeout;
let appConfig = { webrtcPort: 8889, rtspPort: 8554, cameras: [] };
const players = new Map();

function logMessage(msg, isAlert = false) {
    const li = document.createElement('li');
    const now = new Date();
    const timeStr = `${now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    li.innerHTML = `<span class="log-msg">${msg}</span> <span class="log-time">${timeStr}</span>`;
    if (isAlert) li.className = 'alert-item';
    logList.insertBefore(li, logList.firstChild);
    logList.scrollTop = 0;
    while (logList.children.length > 20) {
        logList.removeChild(logList.lastChild);
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
        card.className = 'cam-card';
        card.dataset.camId = this.cfg.id;
        card.innerHTML = `
            <div class="cam-card-head">
                <div>
                    <div class="cam-title"></div>
                    <div class="cam-meta"></div>
                </div>
                <div class="cam-actions">
                    <span class="cam-status offline">Offline</span>
                    <button type="button" class="chip btn-toggle">Kết nối</button>
                    <button type="button" class="chip chip-ghost btn-edit">Sửa</button>
                </div>
            </div>
            <div class="video-box">
                <video autoplay muted playsinline></video>
                <div class="video-overlay">Chưa kết nối</div>
            </div>
        `;
        this.els = {
            card,
            title: card.querySelector('.cam-title'),
            meta: card.querySelector('.cam-meta'),
            status: card.querySelector('.cam-status'),
            toggle: card.querySelector('.btn-toggle'),
            edit: card.querySelector('.btn-edit'),
            video: card.querySelector('video'),
            overlay: card.querySelector('.video-overlay'),
            box: card.querySelector('.video-box')
        };
        this.els.title.textContent = this.cfg.name;
        this.els.meta.textContent = `path /${this.cfg.path}`;
        this.els.toggle.addEventListener('click', () => {
            if (this.connected || this.connecting) this.stop();
            else this.start();
        });
        this.els.edit.addEventListener('click', () => openCamModal(this.cfg));
        return card;
    }

    setStatus(text, kind) {
        this.els.status.textContent = text;
        this.els.status.className = 'cam-status ' + kind;
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
        this.els.toggle.textContent = 'Tắt';
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
        this.els.toggle.textContent = 'Tắt';
    }

    async stop() {
        this.session += 1;
        this.connecting = false;
        this.connected = false;
        await this.cleanup();
        this.hideIframe();
        this.setOverlay('Chưa kết nối', true);
        this.setStatus('Offline', 'offline');
        this.els.toggle.textContent = 'Kết nối';
        this.setAlert(false);
    }

    matchesSensor(sensorId) {
        if (!this.cfg.sensorIds || this.cfg.sensorIds.length === 0) return true;
        return this.cfg.sensorIds.includes(sensorId) || this.cfg.sensorIds.includes('*');
    }
}

function destroyPlayers() {
    players.forEach((p) => p.stop());
    players.clear();
    cameraGrid.innerHTML = '';
}

function renderCameras() {
    destroyPlayers();
    const list = (appConfig.cameras || []).filter((c) => c.enabled);
    cameraGrid.style.gridTemplateColumns = list.length === 1
        ? '1fr'
        : 'repeat(auto-fit, minmax(320px, 1fr))';
    list.forEach((cfg) => {
        const player = new CameraPlayer(cfg);
        players.set(cfg.id, player);
        cameraGrid.appendChild(player.root);
        if (cfg.autoConnect) {
            setTimeout(() => player.start(), 400);
        }
    });
}

async function loadConfig() {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Không tải được cấu hình');
    appConfig = await res.json();
    renderCameras();
}

function openCamModal(existing) {
    camForm.dataset.editId = existing ? existing.id : '';
    document.getElementById('cam-modal-title').textContent = existing ? 'Sửa camera' : 'Thêm camera';
    document.getElementById('cam-name').value = existing ? existing.name : '';
    document.getElementById('cam-id').value = existing ? existing.id : '';
    document.getElementById('cam-id').disabled = Boolean(existing);
    document.getElementById('cam-sensors').value = existing && existing.sensorIds ? existing.sensorIds.join(', ') : '';
    document.getElementById('cam-auto').checked = existing ? existing.autoConnect !== false : true;
    camModal.classList.remove('hidden');
}

function closeCamModal() {
    camModal.classList.add('hidden');
}

btnAddCam.addEventListener('click', () => openCamModal(null));
document.getElementById('cam-modal-cancel').addEventListener('click', closeCamModal);
camModal.addEventListener('click', (e) => {
    if (e.target === camModal) closeCamModal();
});

camForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
        name: document.getElementById('cam-name').value.trim(),
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

btnChangePass.addEventListener('click', async () => {
    const newPass = prompt('Mật khẩu mới:');
    if (!newPass) return;
    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword: newPass })
        });
        const data = await res.json();
        if (data.success) {
            document.cookie = `auth_token=${newPass}; max-age=31536000; path=/`;
            alert('Đổi mật khẩu thành công');
        } else {
            alert('Đổi mật khẩu thất bại');
        }
    } catch (err) {
        alert('Lỗi kết nối máy chủ');
    }
});

btnClearLog.addEventListener('click', () => {
    logList.innerHTML = '';
});

btnActivate.addEventListener('click', () => {
    if (!isSystemActive) {
        audioPlayer.volume = 0;
        audioPlayer.play().then(() => {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            audioPlayer.volume = 1;
            isSystemActive = true;
            btnActivate.textContent = 'Còi đã bật';
            btnActivate.classList.add('on');
            logMessage('Còi báo động đã bật. Khi có gas sẽ kêu siren.');
        }).catch(() => {
            alert('Không phát được siren.mp3. Kiểm tra file trong thư mục public.');
        });
    } else {
        isSystemActive = false;
        btnActivate.textContent = 'Bật còi báo';
        btnActivate.classList.remove('on');
        logMessage('Còi báo động đã tắt');
        if (!audioPlayer.paused) {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        }
    }
});

btnStop.addEventListener('click', () => stopAlarm());

socket.on('ALARM_TRIGGERED', (data) => {
    statusText.textContent = 'Cảnh báo: phát hiện bình gas';
    statusText.className = 'status-danger';
    btnStop.classList.remove('hidden');
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
    statusText.textContent = 'Chưa phát hiện bình gas';
    statusText.className = 'status-safe';
    btnStop.classList.add('hidden');
    players.forEach((player) => player.setAlert(false));
    logMessage('Đã tắt báo động');
}

document.addEventListener('DOMContentLoaded', () => {
    loadConfig().catch((err) => {
        console.error(err);
        logMessage('Không tải được danh sách camera');
    });
});
