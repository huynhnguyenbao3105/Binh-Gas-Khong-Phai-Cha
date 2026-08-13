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
// LOGIC CAMERA HLS (BẤT TỬ TRƯỚC TƯỜNG LỬA)
// ==========================================
window.isCameraConnected = false;

function startCamera() {
    const videoOverlay = document.getElementById('video-overlay');
    const camStatus = document.getElementById('cam-status');
    const btnConnectCam = document.getElementById('btn-connect-cam');
    const videoStream = document.getElementById('video-stream');
    
    // Tự động lấy URL IP hiện tại và trỏ vào port 8888 của HLS
    const hostname = window.location.hostname;
    const hlsUrl = 'http://' + hostname + ':8888/cam/';

    videoOverlay.style.display = 'none';
    
    // Nhúng iframe đè lên thẻ video cũ
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
        
        videoStream.parentElement.style.position = 'relative';
        videoStream.parentElement.appendChild(iframe);
    }
    
    iframe.src = hlsUrl;
    iframe.style.display = 'block';

    camStatus.textContent = "Online";
    camStatus.className = "status-online";
    window.isCameraConnected = true;
    
    btnConnectCam.textContent = "Tắt Camera";
    btnConnectCam.style.backgroundColor = "#ef4444";
}

function stopCamera() {
    const camStatus = document.getElementById('cam-status');
    const btnConnectCam = document.getElementById('btn-connect-cam');
    const iframe = document.getElementById('hls-iframe');
    const videoOverlay = document.getElementById('video-overlay');
    
    if (iframe) {
        iframe.style.display = 'none';
        iframe.src = '';
    }
    
    videoOverlay.style.display = 'flex';
    videoOverlay.textContent = "Chưa kết nối Camera";

    camStatus.textContent = "Offline";
    camStatus.className = "status-offline";
    window.isCameraConnected = false;

    btnConnectCam.textContent = "Kết nối Camera";
    btnConnectCam.style.backgroundColor = ""; // Mặc định
}

// Bắt sự kiện nút kết nối
document.addEventListener('DOMContentLoaded', () => {
    const btnConnectCam = document.getElementById('btn-connect-cam');
    if (btnConnectCam) {
        btnConnectCam.addEventListener('click', () => {
            if (window.isCameraConnected) {
                stopCamera();
            } else {
                startCamera();
            }
        });
    }

    // Tự động bật camera sau 1s
    setTimeout(() => {
        if (!window.isCameraConnected) {
            startCamera();
        }
    }, 1000);
});
