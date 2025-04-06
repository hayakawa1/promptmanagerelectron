// const ipcTestButton = document.getElementById('ipc-test');
// const ipcResultSpan = document.getElementById('ipc-result');

// ipcTestButton.addEventListener('click', async () => {
//   try {
//     const result = await window.electronAPI.ping();
//     ipcResultSpan.textContent = result;
//   } catch (error) {
//     console.error('Error pinging main process:', error);
//     ipcResultSpan.textContent = 'Error!';
//   }
// });

// const selectFolderButton = document.getElementById('select-folder-button');

// Listen for status updates from the main process
window.electronAPI.onScanStatusUpdate((statusMessage) => {
  scanStatusParagraph.textContent = statusMessage;
  if (statusMessage.startsWith('完了:')) {
    console.log('Scan finished, clearing search and reloading image grid...');
    imageGrid.innerHTML = '';
    currentGridImages = [];
    selectedImageIds.clear();
    lastClickedImageElement = null;
    currentOffset = 0;
    totalImages = 0;
    isLoading = false;
    currentSearchTerm = ''; // Clear search term
    searchInput.value = ''; // Clear search input visually
    loadImages(); // Reload all images
  }
});

// Listen for menu trigger from main process
window.electronAPI.onTriggerFolderScan(async () => {
  scanStatusParagraph.textContent = 'フォルダを選択中...';
  // No button to disable here, main process handles dialog
  try {
    // Ask the main process to initiate the folder selection
    const result = await window.electronAPI.selectFolderFromMenu();
    // Final status will be set by onScanStatusUpdate or error handling below
    if (!result.success && !result.cancelled) { // Check if it wasn't just cancelled
        scanStatusParagraph.textContent = `エラー: ${result.message}`;
    } else if (result.cancelled) {
        scanStatusParagraph.textContent = 'フォルダ選択がキャンセルされました。';
    }
  } catch (error) {
    console.error('Error triggering folder selection:', error);
    scanStatusParagraph.textContent = '処理中に予期せぬエラーが発生しました。';
  }
});

// --- State Management Object ---
const appState = {
  pageSize: 150,
  currentOffset: 0,
  totalImages: 0,
  isLoading: false,
  selectedImageIds: new Set(),
  lastClickedImageElement: null,
  currentGridImages: [], // References to grid image elements
  currentSearchTerm: '',
  currentFolderFilter: '',
  currentPngWordFilter: '',
  debounceTimer: null
};

// --- Constants ---
// const PAGE_SIZE = 150;

// --- Selection State Management (moved into appState) ---
// const selectedImageIds = new Set();
// let lastClickedImageElement = null;
// let currentGridImages = [];

// --- Modal Elements (Declare globally, assign in DOMContentLoaded) ---
let modalOverlay = null;
let modalImage = null;
let modalCloseButton = null;
let modalPngInfo = null;

// --- Toolbar/Control Elements (Declare globally, assign in DOMContentLoaded) ---
let deleteSelectedButton = null;
let memoInput = null;
let updateMemoButton = null;
let exportSelectedButton = null;
let searchInput = null;
let folderFilter = null;
let pngWordFilter = null;
let scanStatusParagraph = null;
let imageGrid = null;

// --- State Management Variables (moved into appState) ---
// let currentOffset = 0;
// let totalImages = 0;
// let isLoading = false;
// let currentSearchTerm = '';
// let debounceTimer = null;
// let currentFolderFilter = '';
// let currentPngWordFilter = '';

// --- Helper Functions ---

function clearGridAndResetState() {
    imageGrid.innerHTML = '';
    appState.currentGridImages = [];
    appState.selectedImageIds.clear();
    appState.lastClickedImageElement = null;
    appState.currentOffset = 0;
    appState.totalImages = 0;
    appState.isLoading = false;
}

function resetFiltersAndSearch() {
    appState.currentSearchTerm = '';
    searchInput.value = '';
    appState.currentFolderFilter = '';
    folderFilter.value = '';
    appState.currentPngWordFilter = '';
    pngWordFilter.value = '';
}

function updateStatusText(text) {
    scanStatusParagraph.textContent = text;
}

function updateToolbarButtons() {
    const hasSelection = appState.selectedImageIds.size > 0;
    deleteSelectedButton.disabled = !hasSelection;
    memoInput.disabled = !hasSelection;
    updateMemoButton.disabled = !hasSelection;
    exportSelectedButton.disabled = !hasSelection;
    if (!hasSelection) {
        memoInput.value = '';
    }
}

function generateStatusMessage() {
    if (appState.selectedImageIds.size > 0) {
        return `${appState.selectedImageIds.size} 件選択中`;
    }

    const searchStatus = appState.currentSearchTerm ? `'${appState.currentSearchTerm}' の検索` : '';
    const pngWordStatus = appState.currentPngWordFilter ? `PNG単語 '${appState.currentPngWordFilter}'` : '';
    const folderStatus = appState.currentFolderFilter ? `フォルダ '${appState.currentFolderFilter}' 内` : '全てのフォルダ';
    let baseStatus = '';

    if (searchStatus) baseStatus += searchStatus;
    if (pngWordStatus) baseStatus += (baseStatus ? ' + ' : '') + pngWordStatus;
    if (!searchStatus && !pngWordStatus) baseStatus = folderStatus;
    else if (appState.currentFolderFilter) baseStatus += ` (${folderStatus})`;

    return `${baseStatus}: ${appState.currentOffset} / ${appState.totalImages} 件`;
}

// --- Core Logic Functions ---

// Function to open the modal and load PNG info
async function openModal(imageId, imagePath) {
    console.log(`[openModal] Function called. Attempting to open modal for ID: ${imageId}, Path: ${imagePath}`);
    if (!imagePath || !imageId) {
        console.error('[openModal] Error: imageId or imagePath is missing!');
        return;
    }
    try {
        const encodedPath = encodeURIComponent(imagePath);
        modalImage.src = `atom://${encodedPath}`;
        modalPngInfo.textContent = 'PNG Info 読み込み中...';
        modalOverlay.style.display = 'block';
        console.log('[openModal] Modal overlay displayed. Fetching PNG info...');

        const result = await window.electronAPI.getPngInfo(imageId);
        console.log('[openModal] Received PNG info result:', result);
        if (result.success) {
            modalPngInfo.textContent = result.pngInfo || 'PNG Info はありません。';
        } else {
            modalPngInfo.textContent = `エラー: ${result.message}`;
        }
    } catch (error) {
        console.error('[openModal] Error setting image source or fetching PNG info:', error);
        modalPngInfo.textContent = 'PNG Info の取得または表示中にエラーが発生しました。';
    }
}

// Function to close the modal
function closeModal() {
    modalOverlay.style.display = 'none';
    modalImage.src = '';
    modalPngInfo.textContent = '';
}

// Function to update the visual selection state and relevant UI elements
function updateSelectionVisuals() {
    appState.currentGridImages.forEach(img => {
        if (appState.selectedImageIds.has(parseInt(img.dataset.imageId, 10))) {
            img.classList.add('selected');
        } else {
            img.classList.remove('selected');
        }
    });
    updateToolbarButtons();
    updateStatusText(generateStatusMessage());
    console.log('Selected IDs:', Array.from(appState.selectedImageIds));
}

// Function to create an image element
function createImageElement(image) {
    const img = document.createElement('img');
    const encodedPath = encodeURIComponent(image.original_path);
    img.src = `atom://${encodedPath}`;
    img.alt = image.file_name;
    img.title = `${image.file_name}\nID: ${image.id}\nMemo: ${image.memo || ''}`;
    img.dataset.imageId = image.id;

    img.addEventListener('click', (event) => {
        const clickedId = parseInt(img.dataset.imageId, 10);
        const isCtrlPressed = event.ctrlKey || event.metaKey;
        const isShiftPressed = event.shiftKey;

        if (isShiftPressed && appState.lastClickedImageElement) {
            const lastClickedIndex = appState.currentGridImages.indexOf(appState.lastClickedImageElement);
            const clickedIndex = appState.currentGridImages.indexOf(img);
            if (lastClickedIndex !== -1 && clickedIndex !== -1) {
                const startIndex = Math.min(lastClickedIndex, clickedIndex);
                const endIndex = Math.max(lastClickedIndex, clickedIndex);
                if (!isCtrlPressed) {
                    appState.selectedImageIds.clear();
                }
                for (let i = startIndex; i <= endIndex; i++) {
                    appState.selectedImageIds.add(parseInt(appState.currentGridImages[i].dataset.imageId, 10));
                }
            }
        } else if (isCtrlPressed) {
            if (appState.selectedImageIds.has(clickedId)) {
                appState.selectedImageIds.delete(clickedId);
            } else {
                appState.selectedImageIds.add(clickedId);
            }
            appState.lastClickedImageElement = img;
        } else {
            appState.selectedImageIds.clear();
            appState.selectedImageIds.add(clickedId);
            appState.lastClickedImageElement = img;
        }
        updateSelectionVisuals();
    });

    img.addEventListener('dblclick', () => {
        openModal(image.id, image.original_path);
    });

    return img;
}

// Function to display images in the grid
function displayImages(images) {
    const fragment = document.createDocumentFragment();
    images.forEach(image => {
        const imgElement = createImageElement(image);
        fragment.appendChild(imgElement);
        appState.currentGridImages.push(imgElement);
    });
    imageGrid.appendChild(fragment);
}

// Function to populate a dropdown filter
async function populateFilter(element, apiCall, valueField, textField, currentFilterValue) {
    console.log(`Populating filter: ${element.id}...`);
    try {
        const result = await apiCall();
        if (result.success) {
            const defaultOptionText = element.id === 'folder-filter' ? '全てのフォルダ' : '全てのPNG単語';
            element.innerHTML = `<option value="">${defaultOptionText}</option>`; // Keep default option
            const items = element.id === 'folder-filter' ? result.folders : result.words;
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = item; // Assuming item itself is the value
                option.textContent = item; // Display the item
                element.appendChild(option);
            });
            element.value = currentFilterValue;
            console.log(`Filter ${element.id} populated.`);
        } else {
            console.error(`Failed to populate ${element.id}:`, result.message);
        }
    } catch (error) {
        console.error(`Error calling API for ${element.id}:`, error);
    }
}

// Function to load images (refactored)
async function loadImages(isLoadMore = false) {
    if (appState.isLoading || (isLoadMore && appState.currentOffset >= appState.totalImages)) {
        return;
    }

    const offsetToLoad = isLoadMore ? appState.currentOffset : 0;
    const options = {
        limit: appState.pageSize,
        offset: offsetToLoad,
        term: appState.currentSearchTerm || null,
        folderPath: appState.currentFolderFilter || null,
        pngWord: appState.currentPngWordFilter || null
    };

    console.log(`[loadImages] Attempting to load:`, options);
    appState.isLoading = true;
    updateStatusText(isLoadMore ? 'さらに読み込み中...' : '画像を読み込み中...');

    try {
        let result;
        const isSearchingOrFiltering = options.term || options.folderPath || options.pngWord;

        if (isSearchingOrFiltering) {
            result = await window.electronAPI.searchImages(options);
        } else {
            result = await window.electronAPI.getImages({ limit: options.limit, offset: options.offset });
        }
        console.log('[loadImages] Received result:', result);

        if (result.success) {
            if (!isLoadMore) {
                clearGridAndResetState(); // Clear grid only for initial load/filter change
            }
            displayImages(result.images);
            appState.currentOffset = offsetToLoad + result.images.length;
            appState.totalImages = result.total;
        } else {
            console.error('[loadImages] Failed to load/search images:', result.message);
            updateStatusText(`エラー: ${result.message}`);
            if (!isLoadMore) {
                clearGridAndResetState();
             }
        }
    } catch (error) {
        console.error('[loadImages] Error calling API or processing results:', error);
        updateStatusText('データ取得中に予期せぬエラーが発生しました。');
         if (!isLoadMore) {
            clearGridAndResetState();
         }
    } finally {
        appState.isLoading = false;
        updateStatusText(generateStatusMessage()); // Update status after loading
        console.log(`[loadImages] Setting isLoading to false.`);
    }
}

// --- Event Listeners ---

// Listen for status updates from the main process
window.electronAPI.onScanStatusUpdate(async (statusMessage) => {
  updateStatusText(statusMessage);
  if (statusMessage.startsWith('完了:')) {
    console.log('Scan finished, clearing search, updating filters, and reloading image grid...');
    resetFiltersAndSearch();
    await populateFilter(folderFilter, window.electronAPI.getDistinctFolders, null, null, appState.currentFolderFilter);
    await populateFilter(pngWordFilter, window.electronAPI.getUniquePngWords, null, null, appState.currentPngWordFilter);
    clearGridAndResetState(); // Ensure grid is cleared before loading
    loadImages(); // Reload all images
  }
});

// Listen for menu trigger from main process
window.electronAPI.onTriggerFolderScan(async () => {
  updateStatusText('フォルダを選択中...');
  try {
    const result = await window.electronAPI.selectFolderFromMenu();
    if (!result.success && !result.cancelled) {
        updateStatusText(`エラー: ${result.message}`);
    } else if (result.cancelled) {
        updateStatusText('フォルダ選択がキャンセルされました。');
    }
    // Success status is handled by onScanStatusUpdate
  } catch (error) {
    console.error('Error triggering folder selection:', error);
    updateStatusText('処理中に予期せぬエラーが発生しました。');
  }
});

// --- Filter Change Handlers ---
folderFilter.addEventListener('change', () => {
    appState.currentFolderFilter = folderFilter.value;
    console.log('Folder filter changed:', appState.currentFolderFilter);
    loadImages(); // Reload images with new filter
});

pngWordFilter.addEventListener('change', () => {
    appState.currentPngWordFilter = pngWordFilter.value;
    console.log('PNG word filter changed:', appState.currentPngWordFilter);
    loadImages(); // Reload images with new filter
});

// --- Search Input Listener with Debounce ---
searchInput.addEventListener('input', () => {
    clearTimeout(appState.debounceTimer);
    const searchTerm = searchInput.value.trim();
    appState.debounceTimer = setTimeout(() => {
        if (appState.currentSearchTerm !== searchTerm) { // Only reload if term changed
        console.log(`Search input changed: "${searchTerm}"`);
            appState.currentSearchTerm = searchTerm;
            loadImages(); // Reload images with new search term
        }
    }, 500);
});

// --- Infinite Scroll Logic ---
window.addEventListener('scroll', () => {
    const threshold = 300;
    if (!appState.isLoading && appState.currentOffset < appState.totalImages &&
        (window.innerHeight + window.scrollY) >= document.body.offsetHeight - threshold)
    {   // Load more images
        console.log('Scroll threshold reached, loading more images...');
        loadImages(true); // Pass true to indicate loading more
    }
});

// --- Toolbar Action Button Listeners ---
deleteSelectedButton.addEventListener('click', async () => {
    const idsToDelete = Array.from(appState.selectedImageIds);
    if (idsToDelete.length === 0) return;

    console.log('Requesting deletion for IDs:', idsToDelete);
    updateToolbarButtons(); // Disable buttons
    updateStatusText('削除処理中...');

    try {
        const result = await window.electronAPI.deleteImages(idsToDelete);
        console.log('Delete result:', result);
        updateStatusText(result.message);
        if (result.success) {
            appState.currentGridImages = appState.currentGridImages.filter(img => {
                const imgId = parseInt(img.dataset.imageId, 10);
                if (idsToDelete.includes(imgId)) {
                    img.remove();
                    return false;
                }
                return true;
            });
            appState.selectedImageIds.clear();
            appState.lastClickedImageElement = null;
            appState.totalImages -= result.deletedCount;
        }
    } catch (error) {
        console.error('Error calling deleteImages:', error);
        updateStatusText('画像の削除中に予期せぬエラーが発生しました。');
    } finally {
        updateSelectionVisuals(); // Update UI based on new state
    }
});

updateMemoButton.addEventListener('click', async () => {
    const idsToUpdate = Array.from(appState.selectedImageIds);
    const newMemo = memoInput.value;
    if (idsToUpdate.length === 0) return;

    console.log(`Requesting memo update for IDs: ${idsToUpdate.join(', ')} with memo: "${newMemo}"`);
    updateToolbarButtons(); // Disable buttons
    updateStatusText('メモ更新中...');

    try {
        const result = await window.electronAPI.updateMemos({ imageIds: idsToUpdate, memo: newMemo });
        console.log('Memo update result:', result);
        updateStatusText(result.message);
        if (result.success) {
            idsToUpdate.forEach(id => {
                const imgElement = appState.currentGridImages.find(img => parseInt(img.dataset.imageId, 10) === id);
                if (imgElement) {
                    const parts = imgElement.title.split('\n');
                    if (parts.length >= 3) {
                        imgElement.title = `${parts[0]}\n${parts[1]}\nMemo: ${newMemo || ''}`;
                    }
                }
            });
            memoInput.value = ''; // Clear input on success
        }
    } catch (error) {
        console.error('Error calling updateMemos:', error);
        updateStatusText('メモの更新中に予期せぬエラーが発生しました。');
    } finally {
        updateSelectionVisuals(); // Update UI based on new state
    }
});

exportSelectedButton.addEventListener('click', async () => {
    const idsToExport = Array.from(appState.selectedImageIds);
    if (idsToExport.length === 0) return;

    console.log('Requesting export for IDs:', idsToExport);
    updateToolbarButtons(); // Disable buttons
    updateStatusText('選択した画像を保存中...');

    try {
        const result = await window.electronAPI.exportSelectedImages(idsToExport);
        console.log('Export result:', result);
        updateStatusText(result.message);
    } catch (error) {
        console.error('Error calling exportSelectedImages:', error);
        updateStatusText('画像の保存中に予期せぬエラーが発生しました。');
    } finally {
        updateSelectionVisuals(); // Re-enable buttons etc.
    }
});

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[DOMContentLoaded] Event fired.');

    // --- Assign Element References NOW that DOM is ready ---
    modalOverlay = document.getElementById('modal-overlay');
    modalImage = document.getElementById('modal-image');
    modalCloseButton = document.getElementById('modal-close-button');
    modalPngInfo = document.getElementById('modal-png-info');

    deleteSelectedButton = document.getElementById('delete-selected-button');
    memoInput = document.getElementById('memo-input');
    updateMemoButton = document.getElementById('update-memo-button');
    exportSelectedButton = document.getElementById('export-selected-button');
    searchInput = document.getElementById('search-input');
    folderFilter = document.getElementById('folder-filter');
    pngWordFilter = document.getElementById('png-word-filter');
    scanStatusParagraph = document.getElementById('scan-status');
    imageGrid = document.getElementById('image-grid');

    // Check if essential elements were found
    if (!imageGrid || !scanStatusParagraph || !folderFilter || !pngWordFilter || !searchInput || !deleteSelectedButton || !updateMemoButton || !exportSelectedButton || !memoInput) {
        console.error('Essential UI elements not found! Aborting initialization.');
        const bodyElement = document.querySelector('body');
        if (bodyElement) {
            const errorDiv = document.createElement('div');
            errorDiv.textContent = 'UI要素の読み込みに失敗しました。アプリケーションを再起動してください。';
            errorDiv.style.color = 'red';
            errorDiv.style.padding = '20px';
            bodyElement.insertBefore(errorDiv, bodyElement.firstChild);
        }
        return; // Stop further execution
    }
    // --- End Element Assignment ---

    try {
        // --- Setup Event Listeners NOW that elements are assigned ---

        // Modal listeners
        if (modalCloseButton) modalCloseButton.addEventListener('click', closeModal);
        if (modalOverlay) modalOverlay.addEventListener('click', (event) => { if (event.target === modalOverlay) closeModal(); });

        // Filter Change Handlers
        folderFilter.addEventListener('change', () => {
            appState.currentFolderFilter = folderFilter.value;
            console.log('Folder filter changed:', appState.currentFolderFilter);
            loadImages(); // Reload images with new filter
        });

        pngWordFilter.addEventListener('change', () => {
            appState.currentPngWordFilter = pngWordFilter.value;
            console.log('PNG word filter changed:', appState.currentPngWordFilter);
            loadImages(); // Reload images with new filter
        });

        // Search Input Listener with Debounce
        searchInput.addEventListener('input', () => {
            clearTimeout(appState.debounceTimer);
            const searchTerm = searchInput.value.trim();
            appState.debounceTimer = setTimeout(() => {
                if (appState.currentSearchTerm !== searchTerm) { // Only reload if term changed
                    console.log(`Search input changed: "${searchTerm}"`);
                    appState.currentSearchTerm = searchTerm;
                    loadImages(); // Reload images with new search term
                }
            }, 500);
        });

        // Infinite Scroll Logic
        window.addEventListener('scroll', () => {
            const threshold = 300;
            if (!appState.isLoading && appState.currentOffset < appState.totalImages &&
                (window.innerHeight + window.scrollY) >= document.body.offsetHeight - threshold)
            {   // Load more images
                console.log('Scroll threshold reached, loading more images...');
                loadImages(true); // Pass true to indicate loading more
            }
        });

        // Toolbar Action Button Listeners
        deleteSelectedButton.addEventListener('click', async () => {
            const idsToDelete = Array.from(appState.selectedImageIds);
            if (idsToDelete.length === 0) return;

            console.log('Requesting deletion for IDs:', idsToDelete);
            updateToolbarButtons(); // Disable buttons
            updateStatusText('削除処理中...');

            try {
                const result = await window.electronAPI.deleteImages(idsToDelete);
                console.log('Delete result:', result);
                updateStatusText(result.message);
                if (result.success) {
                    appState.currentGridImages = appState.currentGridImages.filter(img => {
                        const imgId = parseInt(img.dataset.imageId, 10);
                        if (idsToDelete.includes(imgId)) {
                            img.remove();
                            return false;
                        }
                        return true;
                    });
                    appState.selectedImageIds.clear();
                    appState.lastClickedImageElement = null;
                    appState.totalImages -= result.deletedCount;
                }
            } catch (error) {
                console.error('Error calling deleteImages:', error);
                updateStatusText('画像の削除中に予期せぬエラーが発生しました。');
            } finally {
                updateSelectionVisuals(); // Update UI based on new state
            }
        });

        updateMemoButton.addEventListener('click', async () => {
            const idsToUpdate = Array.from(appState.selectedImageIds);
            const newMemo = memoInput.value;
            if (idsToUpdate.length === 0) return;

            console.log(`Requesting memo update for IDs: ${idsToUpdate.join(', ')} with memo: "${newMemo}"`);
            updateToolbarButtons(); // Disable buttons
            updateStatusText('メモ更新中...');

            try {
                const result = await window.electronAPI.updateMemos({ imageIds: idsToUpdate, memo: newMemo });
                console.log('Memo update result:', result);
                updateStatusText(result.message);
                if (result.success) {
                    idsToUpdate.forEach(id => {
                        const imgElement = appState.currentGridImages.find(img => parseInt(img.dataset.imageId, 10) === id);
                        if (imgElement) {
                            const parts = imgElement.title.split('\n');
                            if (parts.length >= 3) {
                                imgElement.title = `${parts[0]}\n${parts[1]}\nMemo: ${newMemo || ''}`;
                            }
                        }
                    });
                    memoInput.value = ''; // Clear input on success
                }
            } catch (error) {
                console.error('Error calling updateMemos:', error);
                updateStatusText('メモの更新中に予期せぬエラーが発生しました。');
            } finally {
                updateSelectionVisuals(); // Update UI based on new state
            }
        });

        exportSelectedButton.addEventListener('click', async () => {
            const idsToExport = Array.from(appState.selectedImageIds);
            if (idsToExport.length === 0) return;

            console.log('Requesting export for IDs:', idsToExport);
            updateToolbarButtons(); // Disable buttons
            updateStatusText('選択した画像を保存中...');

            try {
                const result = await window.electronAPI.exportSelectedImages(idsToExport);
                console.log('Export result:', result);
                updateStatusText(result.message);
            } catch (error) {
                console.error('Error calling exportSelectedImages:', error);
                updateStatusText('画像の保存中に予期せぬエラーが発生しました。');
            } finally {
                updateSelectionVisuals(); // Re-enable buttons etc.
            }
        });
        // --- End Event Listener Setup ---

        // Initial setup
        clearGridAndResetState();
        resetFiltersAndSearch();
        updateToolbarButtons();
        updateStatusText('初期化中...');

        // Populate filters
        await populateFilter(folderFilter, window.electronAPI.getDistinctFolders, null, null, appState.currentFolderFilter);
        await populateFilter(pngWordFilter, window.electronAPI.getUniquePngWords, null, null, appState.currentPngWordFilter);

        console.log('[DOMContentLoaded] State reset. Calling loadImages...');
        loadImages(); // Load initial images
    } catch (error) {
        console.error('[DOMContentLoaded] Error during initial setup:', error);
        updateStatusText('初期化エラーが発生しました。');
    }
});