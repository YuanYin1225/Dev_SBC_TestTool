const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SerialPort } = require('serialport');
const { YmodemSender, MODEM_C, ACK, NAK, CA } = require('./ymodem');

let mainWindow = null;
let serialPort = null;
let tempFilePath = null;      // 当前临时文件路径
let tempFileStream = null;    // 写入流

// Ymodem firmware upgrade state
let isYmodemMode = false;     // 为 true 时绕过 55 BB 帧解析器
let ymodemAbortFlag = false;  // 取消传输标志
let ymodemHandler = null;     // Ymodem 接收数据处理回调

// ========== Window ==========
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'SBC电磁阀驱动器测试工具 ' + app.getVersion(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 批量发送的通道保活依赖 200ms 级定时器(设备端约 316ms 收不到通道指令就会自动关断)。
      // Chromium 默认在窗口失焦/被遮挡/最小化时把定时器节流到 >=1000ms,
      // 会造成"保持期内通道被关断、指示灯转绿", 因此必须显式关闭后台节流。
      backgroundThrottling: false
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

function openSerialPort(portPath, options = {}) {
  const baudRate = options.baudRate || 9600;
  const ymodemMode = options.isYmodem || false;

  return new Promise((resolve, reject) => {
    try {
      serialPort = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false,
        dtr: false,
        rts: false
      });

      // Raw data buffer for binary protocol
      let rawBuffer = Buffer.alloc(0);
      let rawTimer = null;       // 超时定时器：处理无帧头响应（如固件版本）
      const RAW_TIMEOUT = 200;   // 200ms 内无新数据则视为完整帧

      serialPort.on('data', (data) => {
        // Ymodem 模式下不进行 55 BB 帧解析，数据直接交给 ymodemHandler
        if (ymodemMode && ymodemHandler) {
          ymodemHandler(data);
          return;
        }

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
              // 过滤回显命令：55 AA 开头的是发送指令的回显，不是文本响应
              const isEcho = (rawBuffer[0] === 0x55 && rawBuffer[1] === 0xAA);
              if (!isEcho) {
                let crcOk = false;
                let text = '';
                let source = 'unknown';
                // 最后 1 字节 = CRC，前面是文本载荷
                if (rawBuffer.length >= 3) {
                  const payload = rawBuffer.slice(0, -1);
                  const crcByte = rawBuffer[rawBuffer.length - 1];
                  const sum = payload.reduce((s, b) => s + b, 0);
                  crcOk = (sum & 0xFF) === crcByte;
                  text = payload.toString('utf8').replace(/[^\x20-\x7E]/g, '').trim();
                  // 判断是否为固件版本响应：CRC正确且文本较长
                  if (crcOk && text.length >= 2) {
                    source = 'firmware';
                  }
                }
                if (!text) {
                  text = rawBuffer.toString('utf8').replace(/[^\x20-\x7E\r\n]/g, '').trim();
                  if (text.length >= 2) source = 'firmware';
                }
                if (text.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('serial-data', {
                    hex: Array.from(rawBuffer).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
                    parsed: { type: 'text', text: text, crcOk: crcOk, source: source },
                    raw: Array.from(rawBuffer)
                  });
                }
              }
              rawBuffer = Buffer.alloc(0);
            }
          }, RAW_TIMEOUT);
        }
      });

      serialPort.on('error', (err) => {
        if (isYmodemMode) return;  // Ymodem mode handles errors separately
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('serial-error', err.message);
        }
      });

      serialPort.on('close', () => {
        if (isYmodemMode) return;  // suppress event during Ymodem baud-rate switch
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

/** Byte array (or null to stop). Kept as Buffer for zero-copy writes. */
let kaBytes = null;
let kaIntervalMs = 200;
let kaTimer = null;
let kaNextAt = 0;
let kaSent = 0;
let kaMaxGap = 0;
let kaLastAt = 0;

/** Stop the keep-alive repeater. Returns the statistics of the last run. */
function kaStop() {
  if (kaTimer) { clearTimeout(kaTimer); kaTimer = null; }
  kaBytes = null;
  const stat = { sent: kaSent, maxGap: kaMaxGap };
  kaSent = 0;
  kaMaxGap = 0;
  kaLastAt = 0;
  return stat;
}

/**
 * 批量发送的通道保活重发(主进程, 单调时钟排程)。
 *
 * 设备端 APP 收到一条通道指令后只保持约 316ms(见 APP main.h CH_HOLD_TICKS),
 * 超时即自动清零通道 → 电磁阀断开 + 指示灯转绿。因此保活报文的时序必须稳：
 *   - Node 侧定时器不受渲染进程 GC / DOM 卡顿影响;
 *   - 不需要每帧 renderer -> main 的 IPC 往返(旧实现每 200ms 一次);
 *   - 与窗口是否失焦/被遮挡无关(渲染进程仍保留 backgroundThrottling: false 作为双保险)。
 * 渲染进程只负责"换帧"(下一组指令)与"停帧"(间隔期/停止), 并用 ka-progress 事件显示统计。
 */
function kaLoop() {
  kaTimer = null;
  if (!kaBytes) return;

  if (!serialPort || !serialPort.isOpen) {
    kaStop();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ka-progress', { stopped: true, reason: '串口未打开' });
    }
    return;
  }

  const now = Date.now();
  if (kaLastAt > 0) {
    const gap = now - kaLastAt;
    if (gap > kaMaxGap) kaMaxGap = gap;
  }
  kaLastAt = now;
  serialPort.write(kaBytes, () => {});   // 不等回调, 由单调时钟继续排下一拍
  kaSent++;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ka-progress', { sent: kaSent, maxGap: kaMaxGap });
  }

  // 自校正: 下一拍 = 起点 + n*周期; 已过期则立即补发, 不累积漂移
  kaNextAt += kaIntervalMs;
  const due = kaNextAt - Date.now();
  kaTimer = setTimeout(kaLoop, due > 0 ? due : 0);
}

/** Start (or restart) the repeater with a new frame. */
function kaStart(byteArray, intervalMs) {
  kaBytes = Buffer.from(byteArray);
  const iv = parseInt(intervalMs, 10);
  kaIntervalMs = Math.max(50, Math.min(1000, isNaN(iv) ? 200 : iv));
  kaSent = 0;
  kaMaxGap = 0;
  kaLastAt = 0;
  kaNextAt = Date.now();
  if (kaTimer) { clearTimeout(kaTimer); kaTimer = null; }
  kaLoop();
}

function closeSerialPort() {
  kaStop();
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

// ========== Ymodem Firmware Upgrade ==========

/**
 * Send a data buffer to the serial port and wait for drain.
 */
function ymodemWrite(buffer) {
  return new Promise((resolve, reject) => {
    if (!serialPort || !serialPort.isOpen) {
      reject(new Error('串口未打开'));
      return;
    }
    serialPort.write(buffer, (err) => {
      if (err) reject(err);
      else serialPort.drain((err2) => {
        if (err2) reject(err2);
        else resolve();
      });
    });
  });
}

/**
 * Execute the Ymodem firmware upgrade transfer.
 *
 * Flow:
 * 1. Read firmware .bin file into memory
 * 2. Send bootloader entry command (0x2B x 7) at current baud rate
 * 3. Wait 300ms for device to reset
 * 4. Switch serial port to 115200 in Ymodem mode
 * 5. Wait for 'C' from bootloader
 * 6. Send Packet #0 (file info), wait for ACK + 'C'
 * 7. Send data packets, wait for 'C' after each
 * 8. On completion: reopen port at 9600 in normal mode
 *
 * @param {string} portPath - serial port path (e.g. "COM3")
 * @param {string} filePath - path to .bin firmware file
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function executeYmodemTransfer(portPath, filePath) {
  isYmodemMode = true;
  ymodemAbortFlag = false;

  let fileBuffer;
  let fileName;
  let sender;

  try {
    // --- Step 1: Read firmware file ---
    sendYmodemLog('读取固件文件...', 'info');
    fileBuffer = fs.readFileSync(filePath);
    fileName = path.basename(filePath);
    sender = new YmodemSender(fileBuffer, fileName);
    sendYmodemLog(`固件: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB)`, 'info');

    // --- Step 2: Send bootloader entry command ---
    sendYmodemLog('发送 Bootloader 进入命令 (0x2B x 7)...', 'info');
    const bootloaderCmd = [0x2B, 0x2B, 0x2B, 0x2B, 0x2B, 0x2B, 0x2B];
    await sendSerialData(bootloaderCmd);
    sendYmodemLog('等待设备复位进入 Bootloader...', 'info');

    // --- Step 3: Wait for device to reset into bootloader ---
    await sleep(400);

    // --- Step 4: Close port and reopen at 115200 in Ymodem mode ---
    sendYmodemLog('切换波特率至 115200...', 'info');
    if (serialPort && serialPort.isOpen) {
      serialPort.close();
    }
    serialPort = null;
    await sleep(200);

    await openSerialPort(portPath, { baudRate: 115200, isYmodem: true });
    sendYmodemLog('串口已切换至 115200 (8N1)，等待 Bootloader 响应...', 'info');

    // --- Step 5: Set up Ymodem data collector ---
    const { dataQueue, dataResolve, readNextByte, readUntilByte, readBytesUntil } = createDataCollector();

    ymodemHandler = (data) => {
      for (let i = 0; i < data.length; i++) {
        if (dataResolve.current) {
          dataResolve.current(data[i]);
          dataResolve.current = null;
        } else {
          dataQueue.push(data[i]);
        }
      }
    };

    // --- Step 6: Wait for 'C' (0x43) from bootloader ---
    sendYmodemLog('等待 Bootloader 发送 C (0x43)...', 'info');
    try {
      await readUntilByte(MODEM_C, 25000);  // 25-second timeout
    } catch (e) {
      sendYmodemLog('错误: 未收到 Bootloader 响应，请确认设备已进入升级模式', 'error');
      throw new Error('未收到 Bootloader 响应 (超时等待 C)');
    }
    sendYmodemLog('收到 Bootloader 握手信号 (C)，开始传输...', 'success');

    // --- Step 7: Send Packet #0 (file info) ---
    const packet0 = sender.buildPacket0();
    sendYmodemLog(`发送 Packet #0: 文件信息 (${fileName}, ${fileBuffer.length} bytes)`, 'info');
    await ymodemWrite(packet0);

    // Wait for ACK (0x06) then 'C' (0x43) from device
    sendYmodemLog('等待 ACK + C...', 'info');
    try {
      let gotAck = false;
      let gotC = false;
      const startTime = Date.now();
      const timeout = 25000;

      while (!gotAck || !gotC) {
        if (Date.now() - startTime > timeout) {
          throw new Error('超时等待 ACK/C');
        }
        if (ymodemAbortFlag) throw new Error('传输取消');

        const byte = await readNextByte(5000);
        if (byte === ACK && !gotAck) {
          gotAck = true;
          sendYmodemLog('收到 ACK (0x06)', 'success');
        } else if (byte === MODEM_C && gotAck) {
          gotC = true;
          sendYmodemLog('收到 C (0x43)', 'success');
        } else if (byte === NAK) {
          sendYmodemLog('收到 NAK (0x15)，重发 Packet #0...', 'warning');
          await ymodemWrite(packet0);
          gotAck = false;
          gotC = false;
          startTime = Date.now(); // reset timer
        } else if (byte === CA) {
          throw new Error('设备请求取消传输 (CA)');
        }
      }
    } catch (e) {
      sendYmodemLog(`错误: ACK/C 等待失败 - ${e.message}`, 'error');
      throw e;
    }

    // --- Step 8: Send data packets ---
    sendYmodemLog('开始发送固件数据...', 'info');
    const MAX_RETRIES = 8;

    while (!sender.isComplete()) {
      if (ymodemAbortFlag) {
        sendYmodemLog('传输被用户取消', 'warning');
        throw new Error('传输取消');
      }

      // Send the next data packet (with retry loop)
      let packet = sender.nextDataPacket();
      if (!packet) break;

      await ymodemWrite(packet);

      // Report progress
      const progress = sender.getProgress();
      sendYmodemProgress(progress);
      sendYmodemLog(
        `发送 Packet #${progress.packetsSent}/${progress.totalPackets - 1} ` +
        `(${progress.percent}% — ${(progress.offset / 1024).toFixed(1)} KB)`,
        'info'
      );

      // Skip waiting for response after the last packet
      if (sender.isComplete()) {
        sendYmodemLog('所有数据已发送，等待设备完成烧录...', 'success');
        break;
      }

      // Wait for 'C' (0x43) response, with retry on NAK
      let retryCount = 0;
      let gotResponse = false;
      let strayCount = 0;
      while (!gotResponse && retryCount <= MAX_RETRIES) {
        if (ymodemAbortFlag) throw new Error('传输取消');

        try {
          const byte = await readNextByte(15000);
          if (byte === MODEM_C) {
            gotResponse = true;
          } else if (byte === NAK) {
            retryCount++;
            if (retryCount > MAX_RETRIES) {
              throw new Error(`重试超过 ${MAX_RETRIES} 次`);
            }
            sendYmodemLog(`收到 NAK (0x15)，重发 (${retryCount}/${MAX_RETRIES})...`, 'warning');
            await ymodemWrite(packet);
          } else if (byte === CA) {
            throw new Error('设备请求取消传输 (CA)');
          } else {
            // 非协议字节多为 Boot 的 printf 文本输出（版本信息/错误提示），聚合提示避免刷屏
            strayCount++;
            if (strayCount === 1 || strayCount % 100 === 0) {
              sendYmodemLog(`收到非协议字节 ${strayCount} 个（可能为 Boot 文本输出），忽略...`, 'warning');
            }
          }
        } catch (e) {
          if (retryCount >= MAX_RETRIES) {
            sendYmodemLog(`错误: 等待 C 超时/失败 - ${e.message}`, 'error');
            throw new Error(`数据包响应超时: ${e.message}`);
          }
          retryCount++;
          sendYmodemLog(`超时，重发 (${retryCount}/${MAX_RETRIES})...`, 'warning');
          await ymodemWrite(packet);
        }
      }
      if (strayCount > 0) {
        sendYmodemLog(`本包共忽略非协议字节 ${strayCount} 个`, 'info');
      }
    }

    // --- Step 9: Transfer complete ---
    sendYmodemProgress({ offset: sender.fileSize, total: sender.fileSize, percent: 100,
      packetsSent: sender.packetsSent, totalPackets: sender.totalPackets });
    sendYmodemLog('固件传输完成!', 'success');
    sendYmodemLog('设备正在烧录 Flash 并跳转到新固件...', 'info');

    // Wait for device to finish flashing and jump to app
    await sleep(2000);

    // --- Step 10: Restore normal serial port at 9600 ---
    sendYmodemLog('恢复串口至 9600 (正常模式)...', 'info');
    ymodemHandler = null;
    if (serialPort && serialPort.isOpen) {
      serialPort.close();
    }
    serialPort = null;
    await sleep(300);

    isYmodemMode = false;
    await openSerialPort(portPath, { baudRate: 9600, isYmodem: false });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ymodem-complete', {
        fileName: fileName,
        fileSize: fileBuffer.length
      });
    }

    sendYmodemLog('串口已恢复，升级完成!', 'success');
    return { success: true };

  } catch (err) {
    // --- Error recovery ---
    sendYmodemLog(`升级失败: ${err.message}`, 'error');

    // Clean up Ymodem mode
    ymodemHandler = null;
    if (serialPort && serialPort.isOpen) {
      try { serialPort.close(); } catch (e) { /* ignore */ }
    }
    serialPort = null;
    await sleep(300);

    // Restore normal serial port
    try {
      isYmodemMode = false;
      await openSerialPort(portPath, { baudRate: 9600, isYmodem: false });
      sendYmodemLog('串口已恢复至 9600 (正常模式)', 'info');
    } catch (e2) {
      sendYmodemLog(`警告: 恢复串口失败 - ${e2.message}`, 'warning');
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ymodem-error', {
        error: err.message
      });
    }

    return { success: false, error: err.message };
  }
}

/**
 * Create a buffered byte collector for half-duplex Ymodem communication.
 * Provides Promise-based access to incoming serial bytes.
 */
function createDataCollector() {
  const dataQueue = [];
  const dataResolve = { current: null };

  function readNextByte(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      // Check queue first
      if (dataQueue.length > 0) {
        resolve(dataQueue.shift());
        return;
      }

      const timer = setTimeout(() => {
        dataResolve.current = null;
        reject(new Error(`超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      dataResolve.current = (byte) => {
        clearTimeout(timer);
        resolve(byte);
      };
    });
  }

  async function readUntilByte(targetByte, timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - startTime);
      const byte = await readNextByte(Math.max(100, remaining));
      if (byte === targetByte) return;
    }
    throw new Error(`超时等待字节 0x${targetByte.toString(16).toUpperCase()} (${timeoutMs}ms)`);
  }

  async function readBytesUntil(targetByte, maxBytes, timeoutMs = 5000) {
    const bytes = [];
    const startTime = Date.now();
    while (bytes.length < maxBytes && (Date.now() - startTime) < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - startTime);
      const byte = await readNextByte(Math.max(100, remaining));
      bytes.push(byte);
      if (byte === targetByte) return bytes;
    }
    return bytes;
  }

  return { dataQueue, dataResolve, readNextByte, readUntilByte, readBytesUntil };
}

/**
 * Sleep helper (ms).
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send Ymodem progress to renderer.
 */
function sendYmodemProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ymodem-progress', progress);
  }
}

/**
 * Send Ymodem log entry to renderer.
 */
function sendYmodemLog(message, type) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ymodem-log', { message, type, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  }
}

// ========== Frame Parser ==========

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
  } else if (dataLen === 0x0E && frame.length >= 14 && frame[4] === 0x81) {
    // Fault code query response: 55 BB 00 0E 81 [faultBitmap] [fault_ch:4] [protectStatus] [I_DCF] [V_12VT] [CRC]
    const faultBitmap = frame[5];
    const faultCh = (frame[6] << 24) | (frame[7] << 16) | (frame[8] << 8) | frame[9];
    const protectStatus = frame[10];
    const I_DCF = frame[11];
    const V_12VT = frame[12];
    return {
      type: 'queryFault',
      crcOk,
      data: {
        faultBitmap: faultBitmap,
        faultCh: faultCh,
        protectStatus: protectStatus,
        I_DCF: I_DCF,
        V_12VT: V_12VT
      }
    };
  } else if (dataLen === 0x0F && frame.length >= 15 && frame[4] === 0x87) {
    // Fault diagnosis config query response: 55 BB 00 0F 87 [faultFlg] [enable_current_check] [enable_tps259_blink] [faultShortCircuitFlg] [faultCurrentOverloadFlg] [fault_ch:4] [CRC]
    const faultCh = (frame[10] << 24) | (frame[11] << 16) | (frame[12] << 8) | frame[13];
    return {
      type: 'diagConfig',
      crcOk,
      data: {
        faultFlg: frame[5],
        enableCurrentCheck: frame[6],
        enableTps259Blink: frame[7],
        faultShortCircuitFlg: frame[8],
        faultCurrentOverloadFlg: frame[9],
        faultCh: faultCh
      }
    };
  } else if (dataLen === 0x0F && frame.length >= 15) {
    // Real-time data response (15 bytes total)
    // 55 BB 00 0F [ch3] [ch2] [ch1] [ch0] [I_MCU] [I_DCF] [V_12VT] [V_DCF] [V_VCC] [T0] [CRC]
    // 电压 ×0.1V, 电流 mA（设备端已是mA单位）, T0 ×10ms
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
ipcMain.handle('get-version', () => app.getVersion());

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

ipcMain.handle('ka-start', async (event, byteArray, intervalMs) => {
  try {
    if (!serialPort || !serialPort.isOpen) return { success: false, error: '串口未打开' };
    kaStart(byteArray, intervalMs);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ka-update', async (event, byteArray) => {
  kaBytes = Buffer.from(byteArray);
  return { success: true };
});

ipcMain.handle('ka-stop', async () => {
  return Object.assign({ success: true }, kaStop());
});

ipcMain.handle('get-port-status', async () => {
  return {
    isOpen: serialPort ? serialPort.isOpen : false,
    path: serialPort ? serialPort.path : null
  };
});

// ========== Ymodem Firmware Upgrade IPC ==========
ipcMain.handle('select-firmware-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择固件文件',
      filters: [
        { name: 'Binary Files', extensions: ['bin'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    return {
      success: true,
      filePath: filePath,
      fileName: path.basename(filePath),
      fileSize: stat.size
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-ymodem', async (event, filePath) => {
  try {
    if (!serialPort || !serialPort.path) {
      return { success: false, error: '串口未连接，请先连接串口' };
    }
    const portPath = serialPort.path;
    return await executeYmodemTransfer(portPath, filePath);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cancel-ymodem', async () => {
  ymodemAbortFlag = true;
  return { success: true };
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
