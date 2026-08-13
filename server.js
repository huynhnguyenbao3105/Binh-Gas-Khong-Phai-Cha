const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

const configPath = path.join(__dirname, 'config.json');

function defaultCameras() {
  return [{
    id: 'cam',
    name: 'Camera 1',
    enabled: true,
    autoConnect: true,
    path: 'cam',
    sensorIds: []
  }];
}

function sanitizeId(value, fallback) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || fallback;
}

function normalizeCamera(cam, index) {
  const fallback = 'cam' + (index === 0 ? '' : index + 1);
  const id = sanitizeId(cam && (cam.id || cam.path), fallback);
  return {
    id,
    name: (cam && cam.name) ? String(cam.name).trim() : id,
    enabled: !cam || cam.enabled !== false,
    autoConnect: !cam || cam.autoConnect !== false,
    path: sanitizeId(cam && cam.path, id),
    sensorIds: Array.isArray(cam && cam.sensorIds)
      ? cam.sensorIds.map((s) => String(s).trim()).filter(Boolean)
      : []
  };
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const cameras = Array.isArray(source.cameras) && source.cameras.length
    ? source.cameras.map(normalizeCamera)
    : defaultCameras();
  return {
    password: source.password || '123',
    cameras
  };
}

function loadConfig() {
  if (fs.existsSync(configPath)) {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  }
  const created = normalizeConfig({ password: '123' });
  fs.writeFileSync(configPath, JSON.stringify(created, null, 2));
  return created;
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeMediaMTXConfigFile();
}

function publicConfig() {
  return {
    webrtcPort: 8889,
    rtspPort: 8554,
    cameras: config.cameras
  };
}

let config = loadConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    const PUBLIC_PATHS = ['/login.html', '/style.css', '/api/trigger', '/api/login', '/siren.mp3'];
    if (PUBLIC_PATHS.includes(req.path)) {
        return next();
    }

    if (req.path.startsWith('/socket.io/')) {
        return next();
    }

    const cookies = req.headers.cookie || '';
    if (cookies.includes(`auth_token=${config.password}`)) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
    if (req.body.password === config.password) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/change-password', (req, res) => {
    const newPass = req.body.newPassword;
    if (newPass && newPass.length > 0) {
        config.password = newPass;
        saveConfig();
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/config', (req, res) => {
    res.json(publicConfig());
});

app.post('/api/cameras', (req, res) => {
    const cam = normalizeCamera(req.body || {}, config.cameras.length);
    if (config.cameras.some((c) => c.id === cam.id || c.path === cam.path)) {
        return res.status(409).json({ success: false, error: 'Camera id/path đã tồn tại' });
    }
    config.cameras.push(cam);
    saveConfig();
    res.json({ success: true, camera: cam, config: publicConfig() });
});

app.put('/api/cameras/:id', (req, res) => {
    const idx = config.cameras.findIndex((c) => c.id === req.params.id);
    if (idx < 0) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy camera' });
    }
    const merged = normalizeCamera({ ...config.cameras[idx], ...req.body, id: req.params.id }, idx);
    const clash = config.cameras.find((c, i) => i !== idx && (c.id === merged.id || c.path === merged.path));
    if (clash) {
        return res.status(409).json({ success: false, error: 'path bị trùng' });
    }
    config.cameras[idx] = merged;
    saveConfig();
    res.json({ success: true, camera: merged, config: publicConfig() });
});

app.delete('/api/cameras/:id', (req, res) => {
    if (config.cameras.length <= 1) {
        return res.status(400).json({ success: false, error: 'Phải giữ ít nhất 1 camera' });
    }
    const before = config.cameras.length;
    config.cameras = config.cameras.filter((c) => c.id !== req.params.id);
    if (config.cameras.length === before) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy camera' });
    }
    saveConfig();
    res.json({ success: true, config: publicConfig() });
});

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
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
    console.log(`API kích hoạt: GET http://localhost:${PORT}/api/trigger`);
    startMediaMTX();
});

function startMediaMTX() {
    const binDir = path.join(__dirname, '.bin');
    const isWindows = os.platform() === 'win32';
    const mtxExeName = isWindows ? 'mediamtx.exe' : 'mediamtx';
    const mtxExe = path.join(binDir, mtxExeName);

    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir);
    }

    writeMediaMTXConfigFile();

    if (fs.existsSync(mtxExe)) {
        if (isMediaMTXRunning()) {
            console.log('MediaMTX đã chạy, bỏ qua spawn mới.');
            return;
        }
        console.log('Đã tìm thấy MediaMTX. Đang chạy ngầm...');
        runMediaMTX(mtxExe, binDir);
    } else {
        console.log('Chưa có MediaMTX. Đang tải về...');
        let downloadCmd = '';
        if (isWindows) {
            const downloadUrl = 'https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_windows_amd64.zip';
            const zipPath = path.join(binDir, 'mediamtx.zip');
            const psCommand = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${zipPath}'; Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force; Remove-Item '${zipPath}'`;
            downloadCmd = `powershell -Command "${psCommand}"`;
        } else {
            const downloadUrl = 'https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_amd64.tar.gz';
            const tarPath = path.join(binDir, 'mediamtx.tar.gz');
            downloadCmd = `wget -O "${tarPath}" "${downloadUrl}" && tar -xzf "${tarPath}" -C "${binDir}" && rm "${tarPath}" && chmod +x "${mtxExe}"`;
        }

        exec(downloadCmd, (error) => {
            if (error) {
                console.error(`Lỗi tải MediaMTX: ${error.message}`);
                return;
            }
            console.log('Tải và giải nén MediaMTX thành công!');
            writeMediaMTXConfigFile();
            runMediaMTX(mtxExe, binDir);
        });
    }
}

function buildMediaMTXConfig() {
    const paths = config.cameras
      .filter((c) => c.enabled)
      .map((c) => `  ${c.path}:`)
      .join('\n');

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
${paths || '  cam:'}
`;
}

function writeMediaMTXConfigFile() {
    const ymlPath = path.join(__dirname, '.bin', 'mediamtx.yml');
    const binDir = path.join(__dirname, '.bin');
    try {
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir);
        }
        fs.writeFileSync(ymlPath, buildMediaMTXConfig());
    } catch (err) {
        console.warn('Không ghi được mediamtx.yml:', err.message);
    }
}

function isMediaMTXRunning() {
    try {
        const { execSync } = require('child_process');
        const out = execSync("ss -tlnp | grep ':8554 ' || true", { encoding: 'utf8' });
        return out.includes(':8554');
    } catch (err) {
        return false;
    }
}

function runMediaMTX(exePath, cwd) {
    const mtxProcess = spawn(exePath, [], { cwd: cwd, detached: true, stdio: 'ignore' });
    mtxProcess.unref();
    console.log('MediaMTX đang chạy ngầm ở cổng 8889 (WHEP) và 8554 (RTSP)');
}
