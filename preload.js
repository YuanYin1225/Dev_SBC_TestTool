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

  // Remove listeners
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('serial-data');
    ipcRenderer.removeAllListeners('serial-error');
    ipcRenderer.removeAllListeners('serial-closed');
  }
});
