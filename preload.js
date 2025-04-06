const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  onScanStatusUpdate: (callback) => ipcRenderer.on('scan-status-update', (_event, value) => callback(value)),
  getImages: (options) => ipcRenderer.invoke('get-images', options),
  deleteImages: (imageIds) => ipcRenderer.invoke('delete-images', imageIds),
  updateMemos: (data) => ipcRenderer.invoke('update-memos', data),
  exportSelectedImages: (imageIds) => ipcRenderer.invoke('export-selected-images', imageIds),
  getPngInfo: (imageId) => ipcRenderer.invoke('get-png-info', imageId),
  searchImages: (options) => ipcRenderer.invoke('search-images', options),
  getDistinctFolders: () => ipcRenderer.invoke('get-distinct-folders')
}); 