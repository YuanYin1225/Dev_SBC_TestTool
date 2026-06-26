const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SerialPort } = require('serialport');

let mainWindow = null;
let serialPort = null;
let tempFilePath = null;      // 当前临时文件路径
let tempFileStream = null;    // 写入流

// ========== Window ==========
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'SBC电磁阀驱动器测试工具 V3.2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeSerialPort();
  });
}

// ========== Serial Port ==========
async function listSerialPorts() {
  try {
    const ports = await SerialPort.list();
    return {
      success: true,
      ports: ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        pnpId: p.pnpId || '',
        serialNumber: p.serialNumber || '',
        vendorId: p.vendorId || '',
        productId: p.productId || ''
      }))
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || '无法获取串口列表',
      ports: []
    };
  }
}

function openSerialPort(portPath) {
  return new Promise((resolve, reject) => {
    try {
      serialPort = new SerialPort({
        path: portPath,
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false
      });

      // Raw data buffer for binary protocol
      let rawBuffer = Buffer.alloc(0);
      let rawTimer = null;       // 超时定时器：处理无帧头响应（如固件版本）
      const RAW_TIMEOUT = 200;   // 200ms 内无新数据则视为完整帧

      serialPort.on('data', (data) => {
        // 每次收到数据重置超时
        if (rawTimer) clearTimeout(rawTimer);

        rawBuffer = Buffer.concat([rawBuffer, data]);

        // Try to parse SBC response frames
        while (rawBuffer.length >= 4) {
          // Look for frame header: 55 BB (response)
          let frameStart = -1;
          for (let i = 0; i < rawBuffer.length - 1; i++) {
            if (rawBuffer[i] === 0x55 && rawBuffer[i + 1] === 0xBB) {
              frameStart = i;
              break;
            }
          }

          if (frameStart === -1) {
            // No 55 BB header — might be plain-text response (固件版本)
            // Set timeout: if no more data arrives, treat as text
            break;
          }

          if (frameStart > 0) {
            // Discard bytes before header
            rawBuffer = rawBuffer.slice(frameStart);
          }

          // Need at least 4 bytes for header + length byte
          if (rawBuffer.length < 4) break;

          const dataLen = rawBuffer[3];      // byte 3 = 整帧长度（固件定义）
          const totalLen = dataLen;           // 固件 length 字段 = 总字节数（含 CRC）

          if (totalLen < 4) { rawBuffer = rawBuffer.slice(1); continue; }
          if (rawBuffer.length < totalLen) break; // Wait for more data

          // Extract complete frame
          const frame = rawBuffer.slice(0, totalLen);
          rawBuffer = rawBuffer.slice(totalLen);

          // Parse and send to renderer
          const frameHex = Array.from(frame).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
          const frameInfo = parseResponseFrame(frame);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('serial-data', {
              hex: frameHex,
              parsed: frameInfo,
              raw: Array.from(frame)
            });
          }
        }

        // 无 55 BB 帧头的数据：设置超时，超时后当作文本响应发送（固件版本等）
        if (rawBuffer.length > 0) {
          rawTimer = setTimeout(() => {
            rawTimer = null;
            if (rawBuffer.length > 0) {
              let crcOk = false;
              let text = '';
              // 最后 1 字节 = CRC，前面是文本载荷
              if (rawBuffer.length >= 3) {
                const payload = rawBuffer.slice(0, -1);
                const crcByte = rawBuffer[rawBuffer.length - 1];
                const sum = payload.reduce((s, b) => s + b, 0);
                crcOk = (sum & 0xFF) === crcByte;
                text = payload.toString('utf8').replace(/[^\x20-\x7E]/g, '').trim();
              }
              if (!text) {
                text = rawBuffer.toString('utf8').replace(/[^\x20-\x7E\r\n]/g, '').trim();
              }
              if (text.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('serial-data', {
                  hex: Array.from(rawBuffer).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
                  parsed: { type: 'text', text: text, crcOk: crcOk },
                  raw: Array.from(rawBuffer)
                });
              }
              rawBuffer = Buffer.alloc(0);
            }
          }, RAW_TIMEOUT);
        }
      });

      serialPort.on('error', (err) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('serial-error', err.message);
        }
      });

      serialPort.on('close', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('serial-closed');
        }
      });

      serialPort.open((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function closeSerialPort() {
  if (serialPort && serialPort.isOpen) {
    try {
      serialPort.close();
    } catch (e) { /* ignore */ }
  }
  serialPort = null;
}

function sendSerialData(byteArray) {
  return new Promise((resolve, reject) => {
    if (!serialPort || !serialPort.isOpen) {
      reject(new Error('串口未打开'));
      return;
    }
    const buf = Buffer.from(byteArray);
    serialPort.write(buf, (err) => {
      if (err) reject(err);
      else resolve();
    });
    serialPort.drain((err) => {
      if (err) reject(err);
    });
  });
}

/**
 * Parse SBC response frame
 * Response format: 55 BB 00 [len] [data...] [CRC]
 */
function parseResponseFrame(frame) {
  if (frame.length < 6) return { type: 'unknown' };

  const header1 = frame[0]; // 0x55
  const header2 = frame[1]; // 0xBB
  const funcCode = frame[2]; // 0x00
  const dataLen = frame[3];

  if (header1 !== 0x55 || header2 !== 0xBB) {
    return { type: 'unknown' };
  }

  // Verify CRC
  let sum = 0;
  for (let i = 0; i < frame.length - 1; i++) {
    sum += frame[i];
  }
  const expectedCrc = sum & 0xFF;
  const actualCrc = frame[frame.length - 1];

  const crcOk = (expectedCrc === actualCrc);

  // Parse based on length / content
  if (dataLen === 0x07 && frame.length >= 6) {
    // Query response (0x07 length)
    const subCmd = frame[4];
    if (subCmd === 0x07) {
      // VI77 response: 55 BB 00 07 07 [I_DCF] [CRC]
      return {
        type: 'queryVI77',
        crcOk,
        data: { I_DCF: frame[5] || 0 }
      };
    } else if (subCmd === 0x08) {
      // VI88 response: 55 BB 00 07 08 [I_MCU] [CRC]
      return {
        type: 'queryVI88',
        crcOk,
        data: { I_MCU: frame[5] || 0 }
      };
    } else if (subCmd === 0xA1) {
      // LED status query response: 55 BB 00 07 A1 [blink_flag] [CRC]
      return {
        type: 'queryLED',
        crcOk,
        data: { blinkFlag: frame[5] || 0 }
      };
    } else if (subCmd === 0x00 && frame[5] === 0x01) {
      // ACK for hardware test
      return { type: 'ack', crcOk };
    } else if (subCmd === 0xAA) {
      // Power down/up ACK
      return { type: 'powerAck', crcOk, subType: frame[5] || 0 };
    } else {
      return { type: 'shortResponse', crcOk, raw: Array.from(frame.slice(4, frame.length - 1)) };
    }
  } else if (dataLen === 0x0F && frame.length >= 15) {
    // Real-time data response (15 bytes total)
    // 55 BB 00 0F [ch3] [ch2] [ch1] [ch0] [I_MCU] [I_DCF] [V_12VT] [V_DCF] [V_VCC] [T0] [CRC]
    // 电压 ×0.1V, 电流 ×10mA, T0 ×10ms
    const chStat = ((frame[4] & 0x0F) << 24) | (frame[5] << 16) | (frame[6] << 8) | frame[7];
    return {
      type: 'queryRT',
      crcOk,
      data: {
        chStat: chStat,
        I_MCU: frame[8],
        I_DCF: frame[9],
        V_12VT: frame[10],
        V_DCF: frame[11],
        V_VCC: frame[12],
        T0: frame[13]
      }
    };
  } else if (dataLen === 0xCC) {
    // Old-style real-time data (0xCC status = error)
    const payload = frame.slice(4, frame.length - 1);
    if (payload.length >= 10) {
      const chStat = ((payload[0] & 0x0F) << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
      return {
        type: 'queryRT',
        crcOk,
        data: {
          chStat: chStat,
          I_MCU: payload[4],
          I_DCF: payload[5],
          V_12VT: payload[6],
          V_DCF: payload[7],
          V_VCC: payload[8] || 0,
          T0: payload[9] || 0
        }
      };
    }
    return { type: 'longResponse', crcOk, raw: Array.from(payload) };
  } else if (dataLen === 0x09) {
    // Probably command echo or status
    return { type: 'statusResponse', crcOk, raw: Array.from(frame.slice(4, frame.length - 1)) };
  }

  return {
    type: 'response',
    crcOk,
    len: dataLen,
    raw: Array.from(frame.slice(4, frame.length - 1))
  };
}

// ========== IPC Handlers ==========
ipcMain.handle('list-ports', async () => {
  return await listSerialPorts();
});

ipcMain.handle('open-port', async (event, portPath) => {
  try {
    await openSerialPort(portPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('close-port', async () => {
  closeSerialPort();
  return { success: true };
});

ipcMain.handle('list-ports-raw', async () => {
  try {
    const ports = await SerialPort.list();
    return { success: true, ports };
  } catch (err) {
    return { success: false, error: err.message, ports: [] };
  }
});

ipcMain.handle('send-data', async (event, byteArray) => {
  try {
    await sendSerialData(byteArray);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-port-status', async () => {
  return {
    isOpen: serialPort ? serialPort.isOpen : false,
    path: serialPort ? serialPort.path : null
  };
});

// ========== Temp File (stream large CSV to disk) ==========
ipcMain.handle('start-temp-file', async (event, filename) => {
  try {
    const tmpDir = path.join(os.tmpdir(), 'sbc-tool');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tempFilePath = path.join(tmpDir, filename);
    tempFileStream = fs.createWriteStream(tempFilePath, { flags: 'w', encoding: 'utf8' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('append-temp-file', async (event, text) => {
  try {
    if (!tempFileStream) throw new Error('no open file');
    return new Promise((resolve, reject) => {
      tempFileStream.write(text, (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('finish-temp-file', async () => {
  try {
    if (!tempFileStream) throw new Error('no open file');
    return new Promise((resolve, reject) => {
      tempFileStream.end(() => {
        tempFileStream = null;
        const filePath = tempFilePath;
        tempFilePath = null;
        // 用系统默认程序打开文件
        shell.openPath(filePath);
        resolve({ success: true, path: filePath });
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ========== App Lifecycle ==========
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  closeSerialPort();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  closeSerialPort();
});
