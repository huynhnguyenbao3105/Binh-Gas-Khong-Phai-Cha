const socket = io();

// Các DOM elements
const audioPlayer = document.getElementById('siren-audio');
const btnActivate = document.getElementById('btn-activate');
const btnStop = document.getElementById('btn-stop');
const statusText = document.getElementById('status-text');
const logList = document.getElementById('log-list');
const btnClearLog = document.getElementById('btn-clear-log');
const btnChangePass = document.getElementById('btn-change-pass');

let isSystemActive = false;
let alarmTimeout; // Biến lưu đếm ngược tắt còi

// Đổi mật khẩu
btnChangePass.addEventListener('click', async () => {
    const newPass = prompt("Nhập mật khẩu mới (Lưu ý: Mật khẩu mới sẽ áp dụng ngay lập tức):");
    if (newPass) {
        try {
            const res = await fetch('/api/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword: newPass })
            });
            const data = await res.json();
            if (data.success) {
                // Cập nhật lại cookie
                document.cookie = `auth_token=${newPass}; max-age=31536000; path=/`;
                alert("Đổi mật khẩu thành công!");
            } else {
                alert("Đổi mật khẩu thất bại!");
            }
        } catch (err) {
            console.error(err);
            alert("Lỗi kết nối máy chủ!");
        }
    }
});

// Xóa log
btnClearLog.addEventListener('click', () => {
    logList.innerHTML = '';
});

// Bắt buộc người dùng phải tương tác để trình duyệt cho phép phát âm thanh
btnActivate.addEventListener('click', () => {
    if (!isSystemActive) {
        // Bật âm thanh
        audioPlayer.volume = 0;
        audioPlayer.play().then(() => {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            audioPlayer.volume = 1; 
            
            isSystemActive = true;
            btnActivate.textContent = "🔇 TẮT ÂM THANH";
            btnActivate.style.backgroundColor = "#10b981"; // Màu xanh lá
            logMessage('Hệ thống âm thanh đã BẬT. Đang giám sát...');
        }).catch(err => {
            console.error("Lỗi cấp quyền âm thanh:", err);
            alert("Lỗi phát âm thanh! Bạn đã copy file siren.mp3 vào thư mục public chưa?");
        });
    } else {
        // Tắt âm thanh
        isSystemActive = false;
        btnActivate.textContent = "🔊 BẬT ÂM THANH";
        btnActivate.style.backgroundColor = ""; // Màu mặc định
        logMessage('Hệ thống âm thanh đã TẮT.');
        
        // Nếu còi đang kêu thì tắt còi
        if (!audioPlayer.paused) {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        }
    }
});

// Nút tắt còi báo động bằng tay
btnStop.addEventListener('click', () => {
    stopAlarm();
});

// Nhận sự kiện báo động từ Server
socket.on('ALARM_TRIGGERED', (data) => {
    console.log("ALARM!", data);
    
    // Đổi giao diện
    statusText.textContent = "CẢNH BÁO: BÌNH GAS TỚI BÂY ƠI !!!";
    statusText.className = "status-danger";
    btnStop.classList.remove('hidden');
    
    // Thêm log
    logMessage(`🔥 CÓ BÌNH GAS! (${data.sensorId})`, true);

    // Báo động phần Camera
    const videoContainer = document.getElementById('video-container');
    if (videoContainer) {
        videoContainer.classList.add('camera-alert');
    }
    
    // Tự động bật camera nếu chưa kết nối
    if (typeof startCamera === 'function' && !window.isCameraConnected) {
        startCamera();
    }

    // Phát âm thanh nếu đã được kích hoạt
    if (isSystemActive) {
        // Reset về 0 và phát lại từ đầu
        audioPlayer.currentTime = 0;
        audioPlayer.play().catch(e => console.log("Không thể phát âm thanh, user chưa tương tác", e));
    } else {
        logMessage("Cảnh báo: Âm thanh không thể tự phát vì chưa kích hoạt hệ thống!");
    }

    // TỰ ĐỘNG TẮT CÒI SAU 5 GIÂY
    if (alarmTimeout) {
        clearTimeout(alarmTimeout);
    }
    alarmTimeout = setTimeout(() => {
        stopAlarm();
    }, 5000);
});

function stopAlarm() {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    
    statusText.textContent = "CHƯA PHÁT HIỆN BÌNH GAS";
    statusText.className = "status-safe";
    btnStop.classList.add('hidden');
    
    const videoContainer = document.getElementById('video-container');
    if (videoContainer) {
        videoContainer.classList.remove('camera-alert');
    }
    
    logMessage('Đã tắt báo động. Chưa phát hiện bình gas.');
}

function logMessage(msg, isAlert = false) {
    const li = document.createElement('li');
    
    // Lấy ngày giờ hiện tại ngắn gọn
    const now = new Date();
    const timeStr = `${now.toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit', second:'2-digit'})} - ${now.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit'})}`;
    
    li.innerHTML = `<span class="log-msg">${msg}</span> <span class="log-time">${timeStr}</span>`;
    
    if (isAlert) {
        li.className = 'alert-item';
    }
    
    // Chèn vào đầu danh sách
    logList.insertBefore(li, logList.firstChild);
    
    // Ép thanh cuộn luôn nằm ở trên cùng
    logList.scrollTop = 0;
    
    // Xóa bớt log cũ nếu vượt quá 20 dòng để panel không bao giờ bị dài thêm
    while (logList.children.length > 20) {
        logList.removeChild(logList.lastChild);
    }
}

// ==========================================
// LOGIC CAMERA WEBRTC (WHEP) + FALLBACK HLS
// ==========================================
window.isCameraConnected = false;

let camSession = 0;
let camConnecting = false;
let camPC = null;
let whepResourceUrl = null;
let whepTimeoutId = null;

function defaultWhepUrl() {
    return 'http://' + window.location.hostname + ':8889/cam/whep';
}

function defaultHlsUrl() {
    return 'http://' + window.location.hostname + ':8888/cam/';
}

function defaultWebrtcPageUrl() {
    return 'http://' + window.location.hostname + ':8889/cam/';
}

function setCamStatus(text, className) {
    const camStatus = document.getElementById('cam-status');
    if (!camStatus) return;
    camStatus.textContent = text;
    camStatus.className = className;
}

function setCamButton(connected) {
    const btn = document.getElementById('btn-connect-cam');
    if (!btn) return;
    if (connected) {
        btn.textContent = 'Tắt Camera';
        btn.style.backgroundColor = '#ef4444';
    } else {
        btn.textContent = 'Kết nối Camera';
        btn.style.backgroundColor = '';
    }
}

function setOverlay(text, show) {
    const overlay = document.getElementById('video-overlay');
    if (!overlay) return;
    overlay.textContent = text;
    overlay.style.display = show ? 'flex' : 'none';
}

function prefillWhepUrl() {
    const input = document.getElementById('whep-url');
    if (input && !input.value.trim()) {
        input.value = defaultWhepUrl();
        input.placeholder = defaultWhepUrl();
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

async function cleanupWhep() {
    if (whepTimeoutId) {
        clearTimeout(whepTimeoutId);
        whepTimeoutId = null;
    }

    const pc = camPC;
    camPC = null;
    if (pc) {
        try {
            pc.getReceivers().forEach((r) => {
                if (r.track) r.track.stop();
            });
            pc.close();
        } catch (err) {
            console.warn('PC close failed', err);
        }
    }

    const video = document.getElementById('video-stream');
    if (video) {
        video.srcObject = null;
    }

    if (whepResourceUrl) {
        const resourceUrl = whepResourceUrl;
        whepResourceUrl = null;
        try {
            await fetch(resourceUrl, { method: 'DELETE' });
        } catch (err) {
            console.warn('WHEP DELETE failed', err);
        }
    }
}

function hideHlsIframe() {
    const iframe = document.getElementById('hls-iframe');
    if (iframe) {
        iframe.style.display = 'none';
        iframe.src = '';
    }
}

function sleepMs(ms, session) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            if (session !== camSession) {
                reject(new Error('aborted'));
            } else {
                resolve();
            }
        }, ms);
    });
}

async function isHlsAvailable() {
    try {
        const res = await fetch(defaultHlsUrl() + 'index.m3u8', { cache: 'no-store' });
        return res.ok;
    } catch (err) {
        return false;
    }
}

async function startCamera() {
    if (camConnecting || window.isCameraConnected) return;

    const session = ++camSession;
    camConnecting = true;
    setCamButton(true);
    setCamStatus('Connecting', 'status-connecting');
    setOverlay('Đang kết nối WebRTC...', true);
    hideHlsIframe();

    let loggedWaiting = false;

    while (session === camSession) {
        try {
            await startWhep(session);
            if (session !== camSession) return;
            setOverlay('Chưa kết nối Camera', false);
            setCamStatus('Online (WebRTC)', 'status-online');
            window.isCameraConnected = true;
            camConnecting = false;
            logMessage('Camera WebRTC đã kết nối.');
            return;
        } catch (err) {
            await cleanupWhep();
            if (session !== camSession || (err && err.message === 'aborted')) return;

            console.warn('WHEP failed', err);

            if (err && err.noPublisher) {
                const publishUrl = 'rtsp://' + window.location.hostname + ':8554/cam';
                setOverlay('Chưa có luồng camera\nĐẩy RTSP tới:\n' + publishUrl, true);
                setCamStatus('Connecting', 'status-connecting');
                if (!loggedWaiting) {
                    logMessage('Chưa có publisher. Hãy đẩy RTSP tới ' + publishUrl);
                    loggedWaiting = true;
                }
                try {
                    await sleepMs(3000, session);
                } catch (abortErr) {
                    return;
                }
                continue;
            }

            logMessage('WHEP ICE lỗi, chuyển sang WebRTC player MediaMTX...');
            await startWebrtcPageFallback();
            return;
        }
    }
}

async function startWhep(session) {
    const input = document.getElementById('whep-url');
    const whepUrl = (input && input.value.trim()) || defaultWhepUrl();

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    camPC = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });

    let settled = false;
    let markConnected = () => {};
    const iceConnected = new Promise((resolve, reject) => {
        whepTimeoutId = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error('WHEP timeout'));
            }
        }, 15000);

        markConnected = () => {
            if (settled) return;
            settled = true;
            if (whepTimeoutId) {
                clearTimeout(whepTimeoutId);
                whepTimeoutId = null;
            }
            resolve();
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') markConnected();
            if (pc.connectionState === 'failed' && !settled) {
                settled = true;
                if (whepTimeoutId) {
                    clearTimeout(whepTimeoutId);
                    whepTimeoutId = null;
                }
                reject(new Error('ICE failed'));
            }
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            if (state === 'connected' || state === 'completed') markConnected();
            if (state === 'failed' && !settled) {
                settled = true;
                if (whepTimeoutId) {
                    clearTimeout(whepTimeoutId);
                    whepTimeoutId = null;
                }
                reject(new Error('ICE failed'));
            }
        };
    });

    pc.ontrack = (event) => {
        const video = document.getElementById('video-stream');
        if (!video) return;
        if (event.streams && event.streams[0]) {
            video.srcObject = event.streams[0];
        } else {
            video.srcObject = new MediaStream([event.track]);
        }
        video.muted = true;
        video.play().catch(() => {});
        markConnected();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc);

    if (session !== camSession) {
        throw new Error('aborted');
    }

    const res = await fetch(whepUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sdp',
            'Accept': 'application/sdp'
        },
        body: pc.localDescription.sdp
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error('WHEP HTTP ' + res.status);
        err.noPublisher = res.status === 404 || /no one is publishing/i.test(body);
        throw err;
    }

    const location = res.headers.get('Location');
    if (location) {
        whepResourceUrl = new URL(location, whepUrl).href;
    }

    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await iceConnected;

    if (session !== camSession) {
        throw new Error('aborted');
    }
}

async function startWebrtcPageFallback() {
    await cleanupWhep();

    const videoStream = document.getElementById('video-stream');
    const webrtcPageUrl = defaultWebrtcPageUrl();

    setOverlay('Chưa kết nối Camera', false);

    let iframe = document.getElementById('hls-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'hls-iframe';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.border = 'none';
        iframe.style.zIndex = '10';
        iframe.style.backgroundColor = '#000';

        if (videoStream) {
            videoStream.parentElement.style.position = 'relative';
            videoStream.parentElement.appendChild(iframe);
        }
    }

    iframe.src = webrtcPageUrl;
    iframe.style.display = 'block';

    setCamStatus('Online (WebRTC)', 'status-online');
    window.isCameraConnected = true;
    camConnecting = false;
    setCamButton(true);
    logMessage('Đang xem WebRTC qua MediaMTX :8889 (không dùng HLS).');
}

async function stopCamera() {
    camSession += 1;
    camConnecting = false;
    window.isCameraConnected = false;

    await cleanupWhep();
    hideHlsIframe();

    setOverlay('Chưa kết nối Camera', true);
    setCamStatus('Offline', 'status-offline');
    setCamButton(false);
}

document.addEventListener('DOMContentLoaded', () => {
    prefillWhepUrl();

    const btnConnectCam = document.getElementById('btn-connect-cam');
    if (btnConnectCam) {
        btnConnectCam.addEventListener('click', () => {
            if (window.isCameraConnected || camConnecting) {
                stopCamera();
            } else {
                startCamera();
            }
        });
    }

    setTimeout(() => {
        if (!window.isCameraConnected && !camConnecting) {
            startCamera();
        }
    }, 1000);
});
