const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFolderFromMenu: () => ipcRenderer.invoke('select-folder-from-menu'),
  getDistinctFolders: () => ipcRenderer.invoke('get-distinct-folders'),
  getImages: (options) => ipcRenderer.invoke('get-images', options),
  updateMemos: (data) => ipcRenderer.invoke('update-memos', data),
  deleteImages: (ids) => ipcRenderer.invoke('delete-images', ids),
  exportSelectedImages: (ids) => ipcRenderer.invoke('export-selected-images', ids),
  getPngInfo: (id) => ipcRenderer.invoke('get-png-info', id),
  searchImages: (options) => ipcRenderer.invoke('search-images', options),
  getUniquePngWords: () => ipcRenderer.invoke('get-unique-png-words'),
  appendMemos: (data) => ipcRenderer.invoke('append-memos', data),
  getRawPngInfo: (id) => ipcRenderer.invoke('get-raw-png-info', id),
  onScanStatusUpdate: (callback) => ipcRenderer.on('scan-status-update', (_event, value) => callback(value)),
  onTriggerFolderScan: (callback) => ipcRenderer.on('trigger-folder-scan', () => callback()),
  onToggleAspectRatio: (callback) => ipcRenderer.on('toggle-aspect-ratio', (_event, isEnabled) => callback(isEnabled))
}); 