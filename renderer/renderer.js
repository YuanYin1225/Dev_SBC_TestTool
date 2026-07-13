// ========== SBC Test Tool - Renderer Logic ==========

// Channel mapping: J-connector → bit position (0-based, bits 0-27 = 28 channels)
const CHANNEL_MAP = [
  { j: 1, k: 1, bit: 5 },  { j: 1, k: 2, bit: 4 },
  { j: 2, k: 1, bit: 17 }, { j: 2, k: 2, bit: 16 },
  { j: 3, k: 1, bit: 3 },  { j: 3, k: 2, bit: 2 },
  { j: 4, k: 1, bit: 15 }, { j: 4, k: 2, bit: 14 },
  { j: 5, k: 1, bit: 1 },  { j: 5, k: 2, bit: 0 },
  { j: 6, k: 1, bit: 13 }, { j: 6, k: 2, bit: 12 },
  { j: 7, k: 1, bit: 11 }, { j: 7, k: 2, bit: 10 },
  { j: 8, k: 1, bit: 23 }, { j: 8, k: 2, bit: 22 },
  { j: 9, k: 1, bit: 9 },  { j: 9, k: 2, bit: 8 },
  { j: 10, k: 1, bit: 21 },{ j: 10, k: 2, bit: 20 },
  { j: 11, k: 1, bit: 7 }, { j: 11, k: 2, bit: 6 },
  { j: 12, k: 1, bit: 19 },{ j: 12, k: 2, bit: 18 },
  { j: 13, k: 1, bit: 24 },{ j: 13, k: 2, bit: 25 },
  { j: 14, k: 1, bit: 26 },{ j: 14, k: 2, bit: 27 }
];

// Active channels (bitmap of 28 bits as booleans)
let activeChannels = new Array(28).fill(false);
let isConnected = false;
let autoQueryTimer = null;

// ========== CRC / Command Utils ==========
function calcCRC(bytes) {
  return bytes.reduce((sum, b) => sum + b, 0) & 0xFF;
}

function buildControlCommand() {
  let chValue = 0;
  for (let i = 0; i < 28; i++) {
    if (activeChannels[i]) {
      chValue |= (1 << i);  // bit[0] = channel 1, bit[27] = channel 28
    }
  }
  const cmd = [
    0x55, 0xAA, 0x00, 0x09,
    (chValue >> 24) & 0x0F,
    (chValue >> 16) & 0xFF,
    (chValue >> 8) & 0xFF,
    chValue & 0xFF
  ];
  cmd.push(calcCRC(cmd));
  return cmd;
}

function buildQueryCommand(subCmd, extraByte = null) {
  const cmd = [0x55, 0xAA, 0x00, 0x07, subCmd];
  if (extraByte !== null) cmd.push(extraByte);
  cmd.push(calcCRC(cmd));
  return cmd;
}

function formatHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function formatTime() {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', { hour12: false });
}

// ========== Serial Port ==========
async function refreshPorts() {
  const select = document.getElementById('portSelect');
  const statusEl = document.getElementById('portStatus');
  const prev = select.value;
  try {
    const result = await window.sbcAPI.listPorts();
    let ports = [];
    if (result && result.success) {
      ports = result.ports || [];
    } else if (result && !result.success) {
      // Show error in dropdown
      select.innerHTML = `<option value="">-- 错误: ${result.error || '无法获取串口'} --</option>`;
      console.error('串口列表获取失败:', result.error);
      addLog('error', '串口扫描失败: ' + (result.error || '未知错误'));
      return;
    } else if (Array.isArray(result)) {
      // Backward compatibility with old format
      ports = result;
    }

    const newPaths = ports.map(p => p.path).sort().join(',');
    const curPaths = Array.from(select.options).filter(o => o.value).map(o => o.value).sort().join(',');
    if (newPaths === curPaths && prev) return;

    select.innerHTML = '<option value="">-- 选择串口 --</option>';
    if (ports.length === 0) {
      select.innerHTML += '<option value="" disabled>-- 未检测到串口，请手动输入 --</option>';
    }
    ports.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.path;
      const label = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
      opt.textContent = label;
      select.appendChild(opt);
    });
    if (prev && ports.some(p => p.path === prev)) select.value = prev;
  } catch (e) {
    select.innerHTML = '<option value="">-- 错误: ' + e.message + ' --</option>';
    console.error('refreshPorts error:', e);
  }
}

async function connectPort() {
  let path = document.getElementById('portSelect').value;
  // Fallback: use manual input if dropdown has no valid selection
  if (!path) {
    const manualInput = document.getElementById('portManual');
    if (manualInput) {
      path = manualInput.value.trim();
    }
  }
  if (!path) {
    addLog('error', '请选择或手动输入串口号（如 COM3）');
    return;
  }

  const result = await window.sbcAPI.openPort(path);
  if (result.success) {
    isConnected = true;
    updateConnectUI();
    addLog('tx', '已连接: ' + path);
    // Auto-start query after connection
    setTimeout(() => queryRealTime(), 300);
  } else {
    addLog('error', '连接失败: ' + result.error);
  }
}

async function disconnectPort() {
  await window.sbcAPI.closePort();
  isConnected = false;
  updateConnectUI();
  stopAutoQuery();
  addLog('tx', '已断开');
}

function updateConnectUI() {
  const btn = document.getElementById('btnConnect');
  const dot = document.getElementById('portStatus');
  const btnSend = document.getElementById('btnSend');

  if (isConnected) {
    btn.textContent = '断开';
    btn.className = 'btn-connect connected';
    dot.className = 'status-dot connected';
  } else {
    btn.textContent = '连接';
    btn.className = 'btn-connect disconnected';
    dot.className = 'status-dot disconnected';
  }
  btnSend.disabled = !isConnected;
}

// ========== Channel Grid ==========
function buildChannelGrid() {
  const grid = document.getElementById('channelGrid');
  grid.innerHTML = '';

  // Group channels by J-connector (J1-J14)
  const groups = {};
  CHANNEL_MAP.forEach(ch => {
    if (!groups[ch.j]) groups[ch.j] = [];
    groups[ch.j].push(ch);
  });

  Object.keys(groups).sort((a,b) => a-b).forEach(j => {
    const group = groups[j];
    const div = document.createElement('div');
    div.className = 'ch-group';
    div.innerHTML = `<div class="ch-label">J${j}</div>`;

    group.forEach(ch => {
      const btn = document.createElement('button');
      btn.className = 'ch-btn';
      btn.textContent = `J${ch.j}-${ch.k}`;
      btn.dataset.bitIdx = ch.bit; // 0-based bit position
      btn.addEventListener('click', () => toggleChannel(ch.bit, btn));
      div.appendChild(btn);
    });

    grid.appendChild(div);
  });
}

function toggleChannel(idx, btn) {
  activeChannels[idx] = !activeChannels[idx];
  updateChannelButtons();
  updateCommandPreview();
}

function updateChannelButtons() {
  const buttons = document.querySelectorAll('.ch-btn');
  buttons.forEach(btn => {
    const idx = parseInt(btn.dataset.bitIdx);
    if (activeChannels[idx]) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function setAllChannels(state) {
  activeChannels.fill(state);
  updateChannelButtons();
  updateCommandPreview();
}

function setRowChannels(row) {
  // row=1: first channel of each J (K1), row=2: second channel (K2)
  activeChannels.fill(false);
  CHANNEL_MAP.forEach(ch => {
    if (ch.k === row) activeChannels[ch.bit] = true;
  });
  updateChannelButtons();
  updateCommandPreview();
}

function updateCommandPreview() {
  const anyActive = activeChannels.some(v => v);
  const cmd = buildControlCommand();
  document.getElementById('cmdPreview').textContent = anyActive
    ? '指令: ' + formatHex(cmd)
    : '';
  document.getElementById('btnSend').disabled = !isConnected;
}

// ========== Send Commands ==========
async function sendControlCommand() {
  if (!isConnected) return;
  const cmd = buildControlCommand();
  try {
    await window.sbcAPI.sendData(cmd);
    addLog('tx', formatHex(cmd), '控制指令');
  } catch (e) {
    addLog('error', '发送失败: ' + e.message);
  }
}

async function sendRawCommand(hexStr) {
  if (!isConnected) return;
  try {
    const parts = hexStr.trim().split(/\s+/);
    const bytes = parts.map(h => parseInt(h, 16));
    if (bytes.some(isNaN)) {
      addLog('error', '指令格式错误');
      return;
    }
    await window.sbcAPI.sendData(bytes);
    addLog('tx', formatHex(bytes), '手动指令');
  } catch (e) {
    addLog('error', '发送失败: ' + e.message);
  }
}

// ========== Query Commands ==========
async function queryRealTime() {
  if (!isConnected) return;
  const cmd = buildQueryCommand(0x60, 0x00);  // 7字节帧: 55 AA 00 07 60 00 [CRC]
  try {
    await window.sbcAPI.sendData(cmd);
  } catch (e) {
    addLog('error', '查询失败: ' + e.message);
  }
}

async function queryFault() {
  if (!isConnected) return;
  const cmd = buildQueryCommand(0x81, 0x00);
  try {
    await window.sbcAPI.sendData(cmd);
    addLog('tx', formatHex(cmd), '故障查询');
  } catch (e) {
    addLog('error', '查询失败: ' + e.message);
  }
}

// ========== Fault Code Query Modal ==========
const FAULT_BITMAP_DEFS = [
  { bit: 0, name: 'TPS259 短路', desc: 'TPS259电子保险丝检测到短路' },
  { bit: 1, name: 'KZ端口/12V 短路', desc: 'KZ端口或12V电源对地短路' },
  { bit: 2, name: '电流过载', desc: '电磁阀驱动电流超过阈值' },
  { bit: 3, name: '电压异常', desc: '12V系统电压超出正常范围' },
  { bit: 4, name: '当前保护中', desc: '设备正处于保护状态' },
];

function openFaultModal() {
  document.getElementById('faultModal').style.display = 'flex';
  resetFaultModal();
  // Auto-query on open
  if (isConnected) {
    queryFaultCode();
  }
}

function closeFaultModal() {
  document.getElementById('faultModal').style.display = 'none';
}

function resetFaultModal() {
  document.getElementById('faultStatusBadge').textContent = '查询中...';
  document.getElementById('faultStatusBadge').className = 'fault-status-badge querying';
  document.getElementById('faultBitmapTable').innerHTML = '';
  document.getElementById('faultChInfo').innerHTML = '<span class="text-muted">查询中...</span>';
  document.getElementById('faultChGrid').innerHTML = '';
  document.getElementById('fmProtectStatus').textContent = '--';
  document.getElementById('fmIDCF').textContent = '--';
  document.getElementById('fmV12VT').textContent = '--';
  document.getElementById('faultRawData').textContent = '--';
}

async function queryFaultCode() {
  if (!isConnected) {
    updateFaultModalStatus('not-connected', '未连接设备');
    return;
  }
  const cmd = buildQueryCommand(0x81, 0x00);
  try {
    await window.sbcAPI.sendData(cmd);
    addLog('tx', formatHex(cmd), '故障码查询');
    document.getElementById('faultStatusBadge').textContent = '已发送查询，等待响应...';
    document.getElementById('faultStatusBadge').className = 'fault-status-badge querying';
  } catch (e) {
    addLog('error', '故障码查询失败: ' + e.message);
    updateFaultModalStatus('error', '发送失败');
  }
}

function updateFaultModalStatus(status, text) {
  const badge = document.getElementById('faultStatusBadge');
  badge.textContent = text;
  badge.className = 'fault-status-badge ' + status;
}

function handleFaultQueryData(data) {
  const { faultBitmap, faultCh, protectStatus, I_DCF, V_12VT } = data;

  // 1. Fault bitmap parsing
  renderFaultBitmap(faultBitmap);

  // 2. Overall status
  if (faultBitmap === 0) {
    updateFaultModalStatus('normal', '✅ 设备正常，无故障');
  } else {
    const faultCount = countBits(faultBitmap);
    updateFaultModalStatus('fault', `⚠ 检测到 ${faultCount} 类故障`);
  }

  // 3. Channel fault records (fault_ch)
  renderFaultChGrid(faultCh);

  // 4. Protection status
  document.getElementById('fmProtectStatus').textContent =
    '0x' + protectStatus.toString(16).padStart(2, '0').toUpperCase() +
    (protectStatus === 0 ? ' (正常)' : ' (有保护动作)');

  // 5. Measurements
  document.getElementById('fmIDCF').textContent = I_DCF + ' mA';
  if (I_DCF > 0) {
    document.getElementById('fmIDCF').style.color = '#e3b341';
  } else {
    document.getElementById('fmIDCF').style.color = '#58a6ff';
  }

  const v12 = (V_12VT * 0.1).toFixed(1);
  document.getElementById('fmV12VT').textContent = v12 + ' V';
  if (V_12VT * 0.1 < 9.0 || V_12VT * 0.1 > 16.0) {
    document.getElementById('fmV12VT').style.color = '#f85149';
  } else {
    document.getElementById('fmV12VT').style.color = '#58a6ff';
  }
}

function renderFaultBitmap(faultBitmap) {
  let html = '<table class="fault-detail-table"><thead><tr>'
    + '<th>位</th><th>故障名称</th><th>状态</th><th>说明</th>'
    + '</tr></thead><tbody>';

  FAULT_BITMAP_DEFS.forEach(def => {
    const bitVal = (faultBitmap >> def.bit) & 1;
    const statusCls = bitVal ? 'fault-bit-fault' : 'fault-bit-ok';
    const statusText = bitVal ? '⚠ 故障' : '✓ 正常';
    html += `<tr class="${statusCls}">`
      + `<td>bit ${def.bit}</td>`
      + `<td>${def.name}</td>`
      + `<td class="fault-status-cell">${statusText}</td>`
      + `<td>${def.desc}</td>`
      + '</tr>';
  });

  html += '</tbody></table>';
  document.getElementById('faultBitmapTable').innerHTML = html;
}

function renderFaultChGrid(faultCh) {
  // Build channel info: each bit in faultCh corresponds to a channel
  // faultCh bit positions match the channel bits from CHANNEL_MAP
  const faultChHex = '0x' + (faultCh >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const faultChBin = (faultCh >>> 0).toString(2).padStart(32, '0');

  // Count faulty channels
  let faultCount = 0;
  for (let i = 0; i < 32; i++) {
    if ((faultCh >>> i) & 1) faultCount++;
  }

  let infoHtml = '';
  if (faultCount === 0) {
    infoHtml = '<span style="color:#3fb950">✅ 所有通道无故障记录</span>';
  } else {
    infoHtml = `<span style="color:#f85149">⚠ ${faultCount} 个通道有故障记录</span>`
      + `<span style="color:#8b949e;margin-left:12px"> (Flash累积记录，故障恢复后自动清零)</span>`;
  }
  infoHtml += `<div style="margin-top:4px;font-family:monospace;font-size:11px;color:#8b949e">`
    + `十六进制: ${faultChHex} &nbsp;|&nbsp; 二进制: ${faultChBin}</div>`;
  document.getElementById('faultChInfo').innerHTML = infoHtml;

  // Build channel grid showing fault status
  // Map CHANNEL_MAP entries to their fault status
  let gridHtml = '<div class="fault-ch-wrapper">';

  const groups = {};
  CHANNEL_MAP.forEach(ch => {
    if (!groups[ch.j]) groups[ch.j] = [];
    groups[ch.j].push(ch);
  });

  Object.keys(groups).sort((a, b) => a - b).forEach(j => {
    const group = groups[j];
    gridHtml += `<div class="fault-ch-group">`;
    gridHtml += `<div class="fault-ch-group-label">J${j}</div>`;

    group.forEach(ch => {
      const isFault = (faultCh >>> ch.bit) & 1;
      const cls = isFault ? 'fault-ch-cell-fault' : 'fault-ch-cell-ok';
      const text = isFault ? '⚠' : '✓';
      gridHtml += `<div class="fault-ch-cell ${cls}" title="J${ch.j}-${ch.k} (bit${ch.bit}): ${isFault ? '有故障记录' : '正常'}">`
        + `<span class="fault-ch-name">J${ch.j}-${ch.k}</span>`
        + `<span class="fault-ch-status">${text}</span>`
        + '</div>';
    });

    gridHtml += '</div>';
  });

  gridHtml += '</div>';
  document.getElementById('faultChGrid').innerHTML = gridHtml;
}

function countBits(n) {
  let count = 0;
  while (n) {
    count += n & 1;
    n >>>= 1;
  }
  return count;
}

function startAutoQuery() {
  const checked = document.getElementById('chkAutoQuery').checked;
  if (checked && isConnected) {
    autoQueryTimer = setInterval(() => queryRealTime(), 1000);
  } else {
    stopAutoQuery();
  }
}

function stopAutoQuery() {
  if (autoQueryTimer) {
    clearInterval(autoQueryTimer);
    autoQueryTimer = null;
  }
}

// ========== Quick Actions ==========
const ACTION_COMMANDS = {
  selftest: { subCmd: 0xAF, extra: 0xAF, label: '自检' },
  hardtest: { subCmd: 0x00, extra: 0x01, label: '所有通道开启1s' },
  queryLED: { subCmd: 0xA1, extra: 0x00, label: '故障灯查询' },
  queryFW: { subCmd: 0x2D, label: '固件版本' },
  // 故障检测 / KZ 指示灯控制 → 0xA0（写入 Flash 掉电保存）
  faultOn: { subCmd: 0xA0, extra: 0x01, label: '开启故障检测' },
  faultOff: { subCmd: 0xA0, extra: 0x00, label: '关闭故障检测' },
  bootloader: { subCmd: 0x2B, label: '设备复位/升级' }
};

async function quickAction(actionName) {
  if (!isConnected) return;
  const action = ACTION_COMMANDS[actionName];
  if (!action) return;

  // 特殊确认
  if (actionName === 'bootloader') {
    if (!confirm('此操作将使设备复位进入升级模式，是否继续？')) return;
  }
  if (actionName === 'faultOff') {
    if (!confirm('关闭故障检测将使设备忽略电磁阀故障，确保安全后继续？')) return;
  }

  // 特殊帧格式：固件查询(0x2D)和Bootloader(0x2B)使用 7 字节相同值
  let cmd;
  if (actionName === 'queryFW') {
    cmd = [0x2D, 0x2D, 0x2D, 0x2D, 0x2D, 0x2D, 0x2D];
  } else if (actionName === 'bootloader') {
    cmd = [0x2B, 0x2B, 0x2B, 0x2B, 0x2B, 0x2B, 0x2B];
  } else {
    cmd = buildQueryCommand(action.subCmd, action.extra);
  }
  try {
    await window.sbcAPI.sendData(cmd);
    addLog('tx', formatHex(cmd), action.label);
    document.getElementById('actionResult').textContent = `已发送: ${action.label}`;
  } catch (e) {
    addLog('error', `${action.label}失败: ` + e.message);
  }
}

// ========== Data Handler ==========
function handleSerialData(data) {
  const { hex, parsed, raw } = data;

  // Build log detail
  let detail = '';
  if (parsed.type === 'queryRT' && parsed.data) {
    const d = parsed.data;
    // 电压 ×0.1V，电流 mA（设备端已是mA单位，无需换算）
    const v12 = (d.V_12VT * 0.1).toFixed(1);
    const vdcf = (d.V_DCF * 0.1).toFixed(1);
    const vvcc = (d.V_VCC * 0.1).toFixed(1);
    const idcf = d.I_DCF;
    const imcu = d.I_MCU;
    detail = `V12=${v12}V V_DCF=${vdcf}V V_VCC=${vvcc}V I_DCF=${idcf}mA I_MCU=${imcu}mA`;

    // Update real-time display
    document.getElementById('valV12').textContent = v12;
    document.getElementById('valVDCF').textContent = vdcf;
    document.getElementById('valIDCF').textContent = idcf;
    document.getElementById('valIMCU').textContent = imcu;

    // Status: 0xCC = 接收失败
    if (!parsed.crcOk) {
      const faultDiv = document.getElementById('faultInfo');
      faultDiv.className = 'fault-info error';
      faultDiv.textContent = '⚠ CRC校验失败 / 通讯异常(0xCC)';
    }
  } else if (parsed.type === 'queryVI77' && parsed.data) {
    document.getElementById('valIDCF').textContent = parsed.data.I_DCF;
    detail = `I_DCF=${parsed.data.I_DCF}mA`;
  } else if (parsed.type === 'queryVI88' && parsed.data) {
    document.getElementById('valIMCU').textContent = parsed.data.I_MCU;
    detail = `I_MCU=${parsed.data.I_MCU}mA`;
  } else if (parsed.type === 'queryLED' && parsed.data) {
    const status = parsed.data.blinkFlag ? '已开启' : '已关闭';
    document.getElementById('ledStatus').textContent = status;
    detail = `故障灯状态: ${status}`;
  } else if (parsed.type === 'queryFault' && parsed.data) {
    // Fault code query response
    const d = parsed.data;
    const v12 = (d.V_12VT * 0.1).toFixed(1);
    detail = `故障查询: faultBitmap=0x${d.faultBitmap.toString(16).padStart(2,'0').toUpperCase()}`
      + ` fault_ch=0x${(d.faultCh>>>0).toString(16).padStart(8,'0').toUpperCase()}`
      + ` protectStatus=0x${d.protectStatus.toString(16).padStart(2,'0').toUpperCase()}`
      + ` I_DCF=${d.I_DCF}mA V_12VT=${v12}V`;
    // Update fault modal if it's open
    if (document.getElementById('faultModal').style.display === 'flex') {
      handleFaultQueryData(d);
    }
    // Update hint
    const hasFault = d.faultBitmap !== 0 || d.faultCh !== 0;
    const hintEl = document.getElementById('faultQueryHint');
    if (hintEl) {
      hintEl.textContent = hasFault ? '⚠ 设备存在故障!' : '✓ 设备正常';
      hintEl.style.color = hasFault ? '#f85149' : '#3fb950';
    }
    // Update raw data field
    document.getElementById('faultRawData').textContent = hex;
  } else if (parsed.type === 'text' && parsed.text) {
    const crcInfo = parsed.crcOk ? ' ✓' : ' ⚠CRC';
    const isFW = (parsed.source === 'firmware');
    if (isFW) {
      // 仅固件版本响应才更新版本显示
      document.getElementById('fwVersion').textContent = parsed.text + crcInfo;
      detail = `固件版本: ${parsed.text}${crcInfo}`;
    } else {
      detail = `文本响应: ${parsed.text}${crcInfo}`;
    }
  }

  if (!parsed.crcOk && parsed.type !== 'unknown') {
    detail += ' [CRC校验失败]';
  }

  addLog('rx', hex, detail);
}

// ========== Log (ring buffer + batched DOM render) ==========
const LOG_MAX = 300;           // 环形缓冲区最大条目
const LOG_BATCH_GAP = 50;     // 批量发送时每隔 N 条才记一条日志
let logBuffer = [];
let logDirty = false;
let logRafId = null;
let batchLogCounter = 0;       // 批量发送日志节流计数

function addLog(type, message, detail) {
  logBuffer.push({
    time: formatTime(),
    arrow: (type === 'tx') ? '→' : (type === 'rx') ? '←' : '!',
    cls: (type === 'error') ? 'error' : type,
    message: message,
    detail: detail || ''
  });

  // 环形缓冲区溢出
  while (logBuffer.length > LOG_MAX) {
    logBuffer.shift();
  }

  // 标记脏，下一帧统一渲染
  if (!logDirty) {
    logDirty = true;
    logRafId = requestAnimationFrame(renderLog);
  }
}

function renderLog() {
  logDirty = false;
  logRafId = null;

  const logArea = document.getElementById('logArea');
  if (!logArea) return;

  // 一次性构建全部 HTML，只做一次 DOM 赋值
  let html = '';
  for (const entry of logBuffer) {
    html += `<div class="log-entry ${entry.cls}">`
      + `<span class="time">${entry.time}</span>`
      + `<span class="arrow">${entry.arrow}</span> `
      + `<span class="hex">${entry.message}</span>`
      + (entry.detail ? `<span class="detail">${entry.detail}</span>` : '')
      + `</div>`;
  }
  if (!html) {
    html = '<div class="log-empty">等待串口数据...</div>';
  }

  logArea.innerHTML = html;
  logArea.scrollTop = logArea.scrollHeight;
}

// 批量发送专用：每 LOG_BATCH_GAP 条才记一条摘要日志
function addBatchLog(current, total, hex) {
  batchLogCounter++;
  if (batchLogCounter % LOG_BATCH_GAP === 0 || current >= total) {
    addLog('tx', hex, `[${current}/${total}] 批量发送中...`);
  }
}

// ========== Command Generator ==========
const MAX_GEN = 500000;         // 批量发送内存上限
const FILE_CHUNK = 50000;       // 写文件分片大小（行数）
let generatedCommands = [];     // 批量发送用（≤MAX_GEN）；超限时为空
let genTotalCount = 0;          // 实际生成总数
let genTruncated = false;
let genCancelFlag = false;
let genTempFile = '';           // 当前临时文件路径（空=未生成）

// All 28 channel bit positions (sorted as J1-1, J1-2, J2-1, ...)
function getAllChannelBits() {
  return CHANNEL_MAP.map(ch => ch.bit);
}

function bitToChannelName(bit) {
  const found = CHANNEL_MAP.find(ch => ch.bit === bit);
  return found ? `J${found.j}-${found.k}` : `位${bit}`;
}

// Generate all C(n,k) combinations lazily using iterative algorithm
function* combinationsGenerator(arr, k) {
  const n = arr.length;
  if (k > n) return;
  const indices = Array.from({ length: k }, (_, i) => i);
  yield indices.map(i => arr[i]);
  while (true) {
    let i = k - 1;
    while (i >= 0 && indices[i] === n - k + i) i--;
    if (i < 0) return;
    indices[i]++;
    for (let j = i + 1; j < k; j++) indices[j] = indices[j - 1] + 1;
    yield indices.map(idx => arr[idx]);
  }
}

// Calculate total combinations C(n,k)
function combinationCount(n, k) {
  if (k > n) return 0;
  if (k > n / 2) k = n - k;
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = result * (n - k + i) / i;
  }
  return Math.round(result);
}

// 将一条组合转成 CSV 行字符串
function comboToCsvRow(comb, n) {
  let chValue = 0;
  comb.forEach(bit => chValue |= (1 << bit));  // bit is already 0-based
  const cmd = [
    0x55, 0xAA, 0x00, 0x09,
    (chValue >> 24) & 0x0F,
    (chValue >> 16) & 0xFF,
    (chValue >> 8) & 0xFF,
    chValue & 0xFF
  ];
  cmd.push(calcCRC(cmd));
  const hex = formatHex(cmd);
  const channels = comb.map(bitToChannelName).join(', ');
  const switches = comb.map(b => `开关${b + 1}`).join(', ');  // Display as 1-based for readability
  return {
    csv: `"${n}通道组合","${channels}","${switches}",0x${chValue.toString(16).padStart(8,'0').toUpperCase()},${hex}`,
    bytes: cmd,
    hex: hex
  };
}

async function generateCommands(n) {
  const allBits = getAllChannelBits();
  const total = combinationCount(28, n);
  const BATCH = 5000;
  const format = document.getElementById('genFormat').value;
  const filename = `SBC命令-${n}通道.${format === 'csv' ? 'csv' : 'txt'}`;

  document.getElementById('genProgress').style.display = 'block';
  document.getElementById('genResult').style.display = 'none';
  document.getElementById('btnGenerate').disabled = true;
  genCancelFlag = false;
  genTruncated = (total > MAX_GEN);
  genTotalCount = 0;
  genTempFile = '';

  generatedCommands = genTruncated ? null : [];

  // 打开磁盘临时文件
  try {
    await window.sbcAPI.startTempFile(filename);
  } catch (e) {
    addLog('error', '创建临时文件失败: ' + e.message);
    document.getElementById('btnGenerate').disabled = false;
    return;
  }

  // 写表头
  if (format === 'csv') {
    await window.sbcAPI.appendTempFile('名称,通道,开关号,32位通道值(十六进制),完整指令(十六进制)\n');
  }

  if (genTruncated) {
    addLog('tx', `N=${n} 共 ${total.toLocaleString()} 条，流式写入磁盘，不占内存`);
  }

  let processed = 0;
  let fileRows = [];
  const gen = combinationsGenerator(allBits, n);

  return new Promise((resolve) => {
    async function processBatch() {
      if (genCancelFlag) {
        try { if (fileRows.length) await window.sbcAPI.appendTempFile(fileRows.join('\n') + '\n');
              await window.sbcAPI.finishTempFile(); } catch(e){}
        document.getElementById('genProgress').style.display = 'none';
        document.getElementById('btnGenerate').disabled = false;
        resolve(); return;
      }

      let count = 0;
      while (count < BATCH) {
        const { value, done } = gen.next();
        if (done) break;
        const row = comboToCsvRow(value, n);
        fileRows.push(format === 'csv' ? row.csv : row.hex);
        if (!genTruncated) {
          generatedCommands.push({ name: `${n}通道组合`, channels: '', switchNos: '', chValue: 0, hex: row.hex, bytes: row.bytes });
        }
        count++;
      }
      processed += count;
      genTotalCount += count;

      if (fileRows.length >= FILE_CHUNK) {
        try { await window.sbcAPI.appendTempFile(fileRows.join('\n') + '\n'); } catch(e) { addLog('error', '写文件失败'); }
        fileRows = [];
      }

      const pct = Math.min(100, total > 0 ? Math.round(processed / total * 100) : 100);
      document.getElementById('genFill').style.width = pct + '%';
      document.getElementById('genText').textContent = `已生成 ${genTotalCount.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;

      if (processed < total && !genCancelFlag) {
        setTimeout(processBatch, 10);
      } else {
        try {
          if (fileRows.length) await window.sbcAPI.appendTempFile(fileRows.join('\n') + '\n');
          const result = await window.sbcAPI.finishTempFile();
          genTempFile = result.path || '';
        } catch(e) { addLog('error', '关闭文件失败'); }
        fileRows = [];
        document.getElementById('genProgress').style.display = 'none';
        document.getElementById('btnGenerate').disabled = false;
        document.getElementById('genResult').style.display = 'flex';
        document.getElementById('genCount').textContent = `共 ${genTotalCount.toLocaleString()} 条指令（文件已自动打开）`;
        addLog('tx', `导出完成: ${filename} (${genTotalCount.toLocaleString()}条)`);
        resolve();
      }
    }
    setTimeout(processBatch, 10);
  });
}

// 下载按钮：文件已由 finishTempFile 自动打开，这里仅提示路径
function downloadGeneratedFile(format) {
  if (genTotalCount === 0) {
    addLog('error', '请先生成指令');
    return;
  }
  // 生成完成时 finishTempFile 已自动调用 shell.openPath 打开文件
  // 如需重新下载，重新生成即可
  addLog('tx', `文件已自动打开。如需重新获取，请重新点击"生成指令"`);
}

function cancelGenerate() {
  genCancelFlag = true;
}

// ========== Batch Send (hold-repeat-gap cycle) ==========
const MAX_BATCH_LOAD = 100000;    // CSV 加载内存上限（条）
const CSV_CHUNK_SIZE = 8000;      // 分片解析行数，避免阻塞 UI
let batchCommands = [];
let batchIndex = 0;
let batchPaused = false;
let batchHoldTimer = null;     // 保持阶段重复发送定时器
let batchHoldStart = 0;        // 当前保持阶段起始时间
let batchHoldCount = 0;        // 当前保持阶段已发送次数
let batchInGap = false;        // 是否在间隔等待中
let csvLoadCancelled = false;

function parseHexLine(line) {
  // Parse a hex string like "55 AA 00 09 00 00 00 30 38" into byte array
  const parts = line.trim().split(/\s+/);
  const bytes = parts.map(h => parseInt(h, 16));
  if (bytes.some(isNaN) || bytes.length < 6) return null;
  return bytes;
}

/** Extract hex string from a single CSV line. Returns null if no valid hex found. */
function extractHexFromLine(line) {
  if (!line.includes(',')) return line.trim();

  const cols = line.split(',');
  // Find the hex column (looks like "55 AA ..." or "55,AA,...")
  for (const col of cols) {
    const cleaned = col.replace(/"/g, '').trim();
    if (/^[0-9A-Fa-f]{2}([\s,][0-9A-Fa-f]{2})+$/.test(cleaned)) {
      return cleaned.replace(/,/g, ' ');
    }
  }
  // If not found, try the last column
  const lastCol = cols[cols.length - 1].replace(/"/g, '').trim();
  if (/^[0-9A-Fa-f]{2}(\s[0-9A-Fa-f]{2})+$/.test(lastCol)) {
    return lastCol;
  }
  return null;
}

/**
 * 分片异步解析 CSV，不阻塞 UI。
 * 每片 CSV_CHUNK_SIZE 行，用 setTimeout 让出主线程。
 */
function parseCSVChunked(text, onComplete, onProgress) {
  const lines = text.split(/\r?\n/);
  let startIdx = (lines[0] && lines[0].includes('完整指令')) ? 1 : 0;
  const totalLines = lines.length - startIdx;
  const commands = [];
  let cursor = startIdx;
  let truncated = false;

  function processChunk() {
    if (csvLoadCancelled) {
      onComplete(commands, totalLines, true);
      return;
    }

    const chunkEnd = Math.min(cursor + CSV_CHUNK_SIZE, lines.length);
    for (let i = cursor; i < chunkEnd; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const hexStr = extractHexFromLine(line);
      if (hexStr) {
        const bytes = parseHexLine(hexStr);
        if (bytes) {
          if (commands.length >= MAX_BATCH_LOAD) {
            truncated = true;
            break;
          }
          commands.push({ hex: formatHex(bytes), bytes: bytes });
        }
      }
    }

    cursor = chunkEnd;

    if (truncated || commands.length >= MAX_BATCH_LOAD) {
      truncated = true;
      onComplete(commands, totalLines, truncated);
      return;
    }

    if (cursor < lines.length) {
      const pct = Math.round((cursor - startIdx) / totalLines * 100);
      if (onProgress) onProgress(pct, commands.length);
      setTimeout(processChunk, 0);  // 让出主线程
    } else {
      onComplete(commands, totalLines, false);
    }
  }

  setTimeout(processChunk, 0);
}

function loadCSVFiles(files) {
  if (!files || files.length === 0) return;

  // 重置状态
  batchCommands = [];
  stopBatchSend();          // 停止正在运行的批量发送
  csvLoadCancelled = false; // 在 stopBatchSend 之后重置，因为它会将其设为 true

  // 显示加载进度条
  document.getElementById('batchProgress').style.display = 'block';
  document.getElementById('batchControls').style.display = 'none';
  document.getElementById('batchInfo').style.display = 'none';
  document.getElementById('genResult').style.display = 'none';
  document.getElementById('btnBatchStart').disabled = true;

  const fileNames = [];
  let allCommands = [];
  let truncated = false;

  // 逐个文件串行加载，进度汇总
  const fileList = Array.from(files);
  let fileIdx = 0;

  function loadNextFile() {
    if (csvLoadCancelled || fileIdx >= fileList.length) {
      onAllFilesLoaded();
      return;
    }

    const file = fileList[fileIdx];
    document.getElementById('batchText').textContent =
      `正在解析: ${file.name} (${fileIdx + 1}/${fileList.length})...`;

    const reader = new FileReader();
    reader.onload = (e) => {
      parseCSVChunked(e.target.result,
        (cmds, totalLines, isTruncated) => {
          if (cmds.length > 0) {
            fileNames.push(file.name);
            allCommands = allCommands.concat(cmds);
          }
          if (isTruncated) truncated = true;
          fileIdx++;
          loadNextFile();
        },
        (pct, loaded) => {
          document.getElementById('batchFill').style.width = Math.min(pct, 100) + '%';
          document.getElementById('batchText').textContent =
            `解析 ${file.name}: ${pct}% (已加载 ${loaded.toLocaleString()} 条)`;
        }
      );
    };
    reader.onerror = () => {
      addLog('error', `读取 ${file.name} 失败`);
      fileIdx++;
      loadNextFile();
    };
    reader.readAsText(file);
  }

  function onAllFilesLoaded() {
    document.getElementById('batchProgress').style.display = 'none';
    document.getElementById('batchFill').style.width = '0%';

    if (allCommands.length === 0) {
      addLog('error', '所有文件均未找到有效指令');
      return;
    }

    batchCommands = allCommands;
    generatedCommands = batchCommands;

    document.getElementById('batchInfo').style.display = 'flex';
    document.getElementById('batchFileName').textContent =
      `文件: ${fileNames.length}个 (${fileNames.slice(0,3).join(', ')}${fileNames.length>3?'...':''})`;
    const capInfo = truncated ? ` (已达上限 ${MAX_BATCH_LOAD.toLocaleString()} 条，超出部分已截断)` : '';
    document.getElementById('batchTotal').textContent =
      `共 ${batchCommands.length.toLocaleString()} 条指令${capInfo}`;
    document.getElementById('batchControls').style.display = 'flex';
    document.getElementById('btnBatchStart').disabled = false;

    if (truncated) {
      addLog('tx', `⚠ 已加载 ${fileNames.length} 个文件，截取前 ${MAX_BATCH_LOAD.toLocaleString()} 条 (总量过大)`);
    } else {
      addLog('tx', `已加载 ${fileNames.length} 个文件，共 ${batchCommands.length.toLocaleString()} 条指令`);
    }
  }

  loadNextFile();
}

// 全关指令 (所有通道关闭)，间隔期间周期发送以主动关断
const ALL_OFF_CMD = [0x55, 0xAA, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x08];
const ALL_OFF_HEX = formatHex(ALL_OFF_CMD);

function startBatchSend() {
  if (!isConnected) { addLog('error', '请先连接串口'); return; }
  if (batchCommands.length === 0) { addLog('error', '没有可发送的指令'); return; }

  batchIndex = 0;
  batchPaused = false;
  batchInGap = false;
  document.getElementById('batchProgress').style.display = 'block';
  document.getElementById('btnBatchStart').textContent = '▶ 运行中';
  document.getElementById('btnBatchStart').disabled = true;
  document.getElementById('btnBatchPause').textContent = '⏸ 暂停';
  sendHoldCycle();
}

function sendHoldCycle() {
  if (batchPaused) return;
  if (batchIndex >= batchCommands.length) { batchSendComplete(); return; }

  const cmd = batchCommands[batchIndex];
  const freqHz = parseInt(document.getElementById('batchFreqHz').value) || 5;
  const repeatMs = Math.round(1000 / Math.max(1, Math.min(10, freqHz))); // 次/s → ms 间隔
  const holdSec = parseInt(document.getElementById('batchHoldSec').value) || 5;
  const gapSec = parseInt(document.getElementById('batchGapSec').value) || 2;
  const holdMs = holdSec * 1000;
  const gapMs = gapSec * 1000;

  batchInGap = false;
  batchHoldStart = Date.now();
  batchHoldCount = 0;

  // 显示当前指令
  document.getElementById('batchCmdPreview').textContent = `[${batchIndex+1}/${batchCommands.length}] ${cmd.hex}`;

  function holdLoop() {
    if (batchPaused) return;

    const elapsed = Date.now() - batchHoldStart;
    if (elapsed >= holdMs) {
      // 保持结束 → 进入间隔，主动发送全关指令关断电磁阀
      batchInGap = true;
      let gapRemaining = gapSec;
      updateBatchProgressHolding(batchIndex + 1, batchCommands.length, gapRemaining, batchHoldCount);

      function gapTick() {
        if (batchPaused) return;
        gapRemaining--;
        if (gapRemaining <= 0) {
          batchIndex++;
          sendHoldCycle();  // 下一组
          return;
        }
        // 间隔期间周期发送全关指令，确保设备真正关断
        window.sbcAPI.sendData(ALL_OFF_CMD).catch(() => {});
        updateBatchProgressHolding(batchIndex + 1, batchCommands.length, gapRemaining, batchHoldCount);
        batchHoldTimer = setTimeout(gapTick, 1000);
      }
      // 进入间隔立即发一次全关
      window.sbcAPI.sendData(ALL_OFF_CMD).catch(() => {});
      batchHoldTimer = setTimeout(gapTick, 1000);
      return;
    }

    // 发送当前指令
    batchHoldCount++;
    window.sbcAPI.sendData(cmd.bytes).then(() => {
      addBatchLog(batchIndex + 1, batchCommands.length, cmd.hex);
    }).catch(err => { addLog('error', `发送失败: ${err.message}`); });

    updateBatchProgressHolding(batchIndex + 1, batchCommands.length,
      Math.round(elapsed / 1000), batchHoldCount);

    if (!batchPaused) {
      batchHoldTimer = setTimeout(holdLoop, repeatMs);
    }
  }
  holdLoop();
}

function updateBatchProgressHolding(idx, total, holdSecElapsed, sentCount) {
  const holdTotal = parseInt(document.getElementById('batchHoldSec').value) || 5;
  const gapTotal = parseInt(document.getElementById('batchGapSec').value) || 2;
  const pct = Math.round(idx / total * 100);
  const fill = document.getElementById('batchFill');
  fill.style.width = pct + '%';
  fill.className = batchPaused ? 'progress-fill paused' : 'progress-fill';

  if (batchInGap) {
    document.getElementById('batchText').textContent =
      `[${idx}/${total}] 间隔等待 ${holdSecElapsed}/${gapTotal}s`;
  } else {
    document.getElementById('batchText').textContent =
      `[${idx}/${total}] 保持 ${holdSecElapsed}/${holdTotal}s (已发${sentCount}次)`;
  }
}

function pauseBatchSend() {
  batchPaused = !batchPaused;
  const btn = document.getElementById('btnBatchPause');
  if (batchPaused) {
    btn.textContent = '▶ 继续';
    if (batchHoldTimer) { clearTimeout(batchHoldTimer); batchHoldTimer = null; }
    document.getElementById('batchFill').className = 'progress-fill paused';
  } else {
    btn.textContent = '⏸ 暂停';
    document.getElementById('batchFill').className = 'progress-fill';
    if (batchInGap) {
      // 继续间隔倒计时 — 简化：直接跳到下一组
      batchIndex++;
      sendHoldCycle();
    } else {
      sendHoldCycle();
    }
  }
}

function stopBatchSend() {
  csvLoadCancelled = true;  // 同时取消正在进行的 CSV 加载
  batchPaused = false;
  if (batchHoldTimer) { clearTimeout(batchHoldTimer); batchHoldTimer = null; }
  batchIndex = batchCommands.length;
  batchSendComplete();
}

function batchSendComplete() {
  if (batchHoldTimer) { clearTimeout(batchHoldTimer); batchHoldTimer = null; }
  batchInGap = false;
  document.getElementById('btnBatchStart').textContent = '▶ 开始';
  document.getElementById('btnBatchStart').disabled = false;
  document.getElementById('btnBatchPause').textContent = '⏸ 暂停';
  document.getElementById('batchFill').style.width = '100%';
  document.getElementById('batchFill').className = 'progress-fill';
  document.getElementById('batchCmdPreview').textContent = '';
  document.getElementById('batchText').textContent = `完成! ${batchCommands.length} 组`;
  addLog('tx', `批量发送结束 (${batchCommands.length}组)`);
}

// ========== Init ==========
function init() {
  buildChannelGrid();
  updateCommandPreview();
  refreshPorts();

  // Periodic port refresh
  setInterval(refreshPorts, 3000);

  // Connect/Disconnect
  document.getElementById('btnConnect').addEventListener('click', () => {
    if (isConnected) disconnectPort();
    else connectPort();
  });

  document.getElementById('btnRefresh').addEventListener('click', refreshPorts);

  // Channel batch buttons
  document.getElementById('btnAllOn').addEventListener('click', () => setAllChannels(true));
  document.getElementById('btnAllOff').addEventListener('click', () => setAllChannels(false));
  document.getElementById('btnRow1').addEventListener('click', () => setRowChannels(1));
  document.getElementById('btnRow2').addEventListener('click', () => setRowChannels(2));

  // Send control
  document.getElementById('btnSend').addEventListener('click', sendControlCommand);

  // Real-time query
  document.getElementById('btnQueryRT').addEventListener('click', queryRealTime);
  document.getElementById('chkAutoQuery').addEventListener('change', startAutoQuery);

  // Quick actions
  document.querySelectorAll('.btn-action').forEach(btn => {
    btn.addEventListener('click', () => quickAction(btn.dataset.action));
  });

  // Fault code query modal
  document.getElementById('btnFaultQuery').addEventListener('click', openFaultModal);
  document.getElementById('btnCloseFaultModal').addEventListener('click', closeFaultModal);
  document.getElementById('btnCloseFaultModal2').addEventListener('click', closeFaultModal);
  document.getElementById('btnRefreshFault').addEventListener('click', () => {
    resetFaultModal();
    queryFaultCode();
  });
  // Close modal on overlay click
  document.getElementById('faultModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('faultModal')) {
      closeFaultModal();
    }
  });
  // ESC key to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('faultModal').style.display === 'flex') {
      closeFaultModal();
    }
  });

  // Manual command
  document.getElementById('btnSendManual').addEventListener('click', () => {
    const hexStr = document.getElementById('txtManualCmd').value;
    if (hexStr.trim()) sendRawCommand(hexStr);
  });
  document.getElementById('txtManualCmd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const hexStr = document.getElementById('txtManualCmd').value;
      if (hexStr.trim()) sendRawCommand(hexStr);
    }
  });

  // Clear log
  document.getElementById('btnClearLog').addEventListener('click', () => {
    logBuffer = [];
    batchLogCounter = 0;
    document.getElementById('logArea').innerHTML = '<div class="log-empty">等待串口数据...</div>';
  });

  // Serial data listener
  window.sbcAPI.onSerialData(handleSerialData);

  window.sbcAPI.onSerialError((msg) => {
    addLog('error', '串口错误: ' + msg);
  });

  window.sbcAPI.onSerialClosed(() => {
    isConnected = false;
    updateConnectUI();
    stopAutoQuery();
    addLog('tx', '串口已关闭');
  });

  // Initial connection status check
  window.sbcAPI.getPortStatus().then(status => {
    if (status.isOpen) {
      isConnected = true;
      updateConnectUI();
      document.getElementById('portSelect').value = status.path || '';
    }
  });

  // --- Command Generator ---
  document.getElementById('btnGenerate').addEventListener('click', () => {
    const n = parseInt(document.getElementById('genChCount').value) || 2;
    if (n < 2 || n > 14) {
      addLog('error', '通道数范围: 2-14');
      return;
    }
    const total = combinationCount(28, n);
    if (total > 500000 && !confirm(`将生成约 ${total.toLocaleString()} 条指令，耗时较长，是否继续？`)) {
      return;
    }
    addLog('tx', `开始生成 ${n} 通道组合 (约${total.toLocaleString()}条)`);
    generateCommands(n).then(() => {
      addLog('tx', `生成完成: ${generatedCommands.length.toLocaleString()} 条`);
    });
  });

  // --- Batch Send ---
  document.getElementById('btnLoadCSV').addEventListener('click', () => {
    document.getElementById('fileCSV').click();
  });
  document.getElementById('fileCSV').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      loadCSVFiles(e.target.files);
    }
  });

  document.getElementById('btnBatchStart').addEventListener('click', startBatchSend);
  document.getElementById('btnBatchPause').addEventListener('click', pauseBatchSend);
  document.getElementById('btnBatchStop').addEventListener('click', stopBatchSend);

  addLog('tx', 'SBC测试工具 V3.2 已就绪');
}

document.addEventListener('DOMContentLoaded', init);
