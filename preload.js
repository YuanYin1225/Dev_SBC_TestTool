const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbcAPI', {
  // Serial port
  listPorts: () => ipcRenderer.invoke('list-ports'),
  listPortsRaw: () => ipcRenderer.invoke('list-ports-raw'),
  openPort: (path) => ipcRenderer.invoke('open-port', path),
  closePort: () => ipcRenderer.invoke('close-port'),
  sendData: (bytes) => ipcRenderer.invoke('send-data', bytes),
  getPortStatus: () => ipcRenderer.invoke('get-port-status'),

  // Temp file (streaming large CSV to disk)
  startTempFile: (filename) => ipcRenderer.invoke('start-temp-file', filename),
  appendTempFile: (text) => ipcRenderer.invoke('append-temp-file', text),
  finishTempFile: () => ipcRenderer.invoke('finish-temp-file'),

  // Ymodem firmware upgrade
  selectFirmwareFile: () => ipcRenderer.invoke('select-firmware-file'),
  startYmodem: (filePath) => ipcRenderer.invoke('start-ymodem', filePath),
  cancelYmodem: () => ipcRenderer.invoke('cancel-ymodem'),

  // Events from main
  onSerialData: (callback) => {
    ipcRenderer.on('serial-data', (event, data) => callback(data));
  },
  onSerialError: (callback) => {
    ipcRenderer.on('serial-error', (event, msg) => callback(msg));
  },
  onSerialClosed: (callback) => {
    ipcRenderer.on('serial-closed', () => callback());
  },

  // Ymodem events
  onYmodemProgress: (callback) => {
    ipcRenderer.on('ymodem-progress', (event, data) => callback(data));
  },
  onYmodemLog: (callback) => {
    ipcRenderer.on('ymodem-log', (event, data) => callback(data));
  },
  onYmodemComplete: (callback) => {
    ipcRenderer.on('ymodem-complete', (event, data) => callback(data));
  },
  onYmodemError: (callback) => {
    ipcRenderer.on('ymodem-error', (event, data) => callback(data));
  },

  // Remove listeners
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('serial-data');
    ipcRenderer.removeAllListeners('serial-error');
    ipcRenderer.removeAllListeners('serial-closed');
    ipcRenderer.removeAllListeners('ymodem-progress');
    ipcRenderer.removeAllListeners('ymodem-log');
    ipcRenderer.removeAllListeners('ymodem-complete');
    ipcRenderer.removeAllListeners('ymodem-error');
  }
});
