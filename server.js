const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

let config = { password: '123' };
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} else {
    fs.writeFileSync(configPath, JSON.stringify(config));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Auth Middleware
app.use((req, res, next) => {
    const PUBLIC_PATHS = ['/login.html', '/style.css', '/api/trigger', '/api/login', '/siren.mp3'];
    if (PUBLIC_PATHS.includes(req.path)) {
        return next();
    }
    
    // Bỏ qua kiểm tra cookie với socket.io
    if (req.path.startsWith('/socket.io/')) {
        return next();
    }
    
    const cookies = req.headers.cookie || '';
    if (cookies.includes(`auth_token=${config.password}`)) {
        return next();
    }
    
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    } else {
        return res.redirect('/login.html');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// API Login
app.post('/api/login', (req, res) => {
    if (req.body.password === config.password) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// API Đổi Mật Khẩu
app.post('/api/change-password', (req, res) => {
    const newPass = req.body.newPassword;
    if (newPass && newPass.length > 0) {
        config.password = newPass;
        fs.writeFileSync(configPath, JSON.stringify(config));
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// API Endpoint cho ESP32 gọi
app.get('/api/trigger', (req, res) => {
    const sensorId = req.query.sensor_id || 'Unknown';
    const distance = req.query.distance || 'N/A';
    const timestamp = new Date().toISOString();

    console.log(`[ALERT] Phát hiện xâm nhập từ Sensor: ${sensorId} lúc ${timestamp}`);

    io.emit('ALARM_TRIGGERED', {
        sensorId,
        distance,
        timestamp
    });

    res.status(200).json({ success: true, message: 'Báo động đã được kích hoạt!' });
});

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
    console.log(`📡 API Kích hoạt còi hú: GET http://localhost:${PORT}/api/trigger`);
    
    // Tự động xử lý MediaMTX
    startMediaMTX();
});

// ==========================================
// TỰ ĐỘNG TẢI VÀ CHẠY MEDIAMTX
// ==========================================
function startMediaMTX() {
    const binDir = path.join(__dirname, '.bin');
    const isWindows = os.platform() === 'win32';
    const mtxExeName = isWindows ? 'mediamtx.exe' : 'mediamtx';
    const mtxExe = path.join(binDir, mtxExeName);
    
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir);
    }

    if (fs.existsSync(mtxExe)) {
        console.log('✅ Đã tìm thấy MediaMTX. Đang chạy ngầm...');
        runMediaMTX(mtxExe, binDir);
    } else {
        console.log(`⏳ Chưa có MediaMTX. Đang tải về...`);
        let downloadCmd = "";
        if (isWindows) {
            const downloadUrl = "https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_windows_amd64.zip";
            const zipPath = path.join(binDir, 'mediamtx.zip');
            const psCommand = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${zipPath}'; Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force; Remove-Item '${zipPath}'`;
            downloadCmd = `powershell -Command "${psCommand}"`;
        } else {
            const downloadUrl = "https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_amd64.tar.gz";
            const tarPath = path.join(binDir, 'mediamtx.tar.gz');
            downloadCmd = `wget -O "${tarPath}" "${downloadUrl}" && tar -xzf "${tarPath}" -C "${binDir}" && rm "${tarPath}" && chmod +x "${mtxExe}"`;
        }
        
        exec(downloadCmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Lỗi tải MediaMTX: ${error.message}`);
                return;
            }
            console.log('✅ Tải và giải nén MediaMTX thành công!');
            
            const ymlPath = path.join(binDir, 'mediamtx.yml');
            let ymlConfig = "";
            if (process.env.VPS_MODE === 'true') {
                ymlConfig = `
paths:
  cam:
`;
            } else {
                ymlConfig = `
paths:
  cam:
    source: rtsp://admin:L26C6CB7@192.168.1.3:554/cam/realmonitor?channel=1&subtype=1
`;
            }
            fs.writeFileSync(ymlPath, ymlConfig);
            runMediaMTX(mtxExe, binDir);
        });
    }
}

function runMediaMTX(exePath, cwd) {
    const mtxProcess = spawn(exePath, [], { cwd: cwd, detached: true, stdio: 'ignore' });
    mtxProcess.unref(); 
    console.log('🚀 MediaMTX đang chạy ngầm thành công ở cổng 8889 (WHEP) và 8554 (RTSP)!');
}
