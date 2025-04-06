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

const selectFolderButton = document.getElementById('select-folder-button');
const scanStatusParagraph = document.getElementById('scan-status');

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

const imageGrid = document.getElementById('image-grid');

const PAGE_SIZE = 150;
let currentOffset = 0;
let totalImages = 0;
let isLoading = false;

// --- Selection State Management ---
const selectedImageIds = new Set();
let lastClickedImageElement = null; // For Shift+Click range selection
let currentGridImages = []; // Array to hold references to the img elements in the grid

// --- Modal Elements (Declare variables, get elements later) ---
let modalOverlay = null;
let modalImage = null;
let modalCloseButton = null;
let modalPngInfo = null;
const deleteSelectedButton = document.getElementById('delete-selected-button');
const memoInput = document.getElementById('memo-input');
const updateMemoButton = document.getElementById('update-memo-button');
const exportSelectedButton = document.getElementById('export-selected-button');
const searchInput = document.getElementById('search-input'); // Get search input
const folderFilter = document.getElementById('folder-filter'); // Get folder filter select
const pngWordFilter = document.getElementById('png-word-filter'); // Get PNG word filter select

// --- State Management ---
let currentSearchTerm = ''; // Store the current search term
let debounceTimer = null; // Timer for debouncing search input
let currentFolderFilter = ''; // Store the selected folder path
let currentPngWordFilter = ''; // Store the selected PNG word

// Function to open the modal and load PNG info
async function openModal(imageId, imagePath) {
    console.log(`[openModal] Function called. Attempting to open modal for ID: ${imageId}, Path: ${imagePath}`);
    if (!imagePath || !imageId) {
        console.error('[openModal] Error: imageId or imagePath is missing!');
        return;
    }
    try {
        // Set image source immediately
        const encodedPath = encodeURIComponent(imagePath);
        modalImage.src = `atom://${encodedPath}`;

        // Clear previous PNG info and show loading message
        modalPngInfo.textContent = 'PNG Info 読み込み中...';
        modalOverlay.style.display = 'block';
        console.log('[openModal] Modal overlay displayed. Fetching PNG info...');

        // Fetch PNG info asynchronously
        const result = await window.electronAPI.getPngInfo(imageId);
        console.log('[openModal] Received PNG info result:', result);

        if (result.success) {
            if (result.pngInfo) {
                modalPngInfo.textContent = result.pngInfo;
            } else {
                modalPngInfo.textContent = 'PNG Info はありません。'; // Handle case where png_info is null/empty
            }
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
    modalPngInfo.textContent = ''; // Clear PNG info when closing
}

// Event listeners for closing the modal (Setup moved to DOMContentLoaded)
// modalCloseButton.addEventListener('click', closeModal);
// modalOverlay.addEventListener('click', (event) => { ... });

// Function to update the visual selection state and relevant UI elements
function updateSelectionVisuals() {
    const hasSelection = selectedImageIds.size > 0;

    currentGridImages.forEach(img => {
        if (selectedImageIds.has(parseInt(img.dataset.imageId, 10))) {
            img.classList.add('selected');
        } else {
            img.classList.remove('selected');
        }
    });

    // Update button states based on selection
    deleteSelectedButton.disabled = !hasSelection;
    memoInput.disabled = !hasSelection;
    updateMemoButton.disabled = !hasSelection;
    exportSelectedButton.disabled = !hasSelection;

    // Clear memo input if nothing is selected
    if (!hasSelection) {
        memoInput.value = '';
    }

    // Update status bar
    const statusText = hasSelection
        ? `${selectedImageIds.size} 件選択中`
        : `表示中: ${currentOffset} / ${totalImages} 件`;
    scanStatusParagraph.textContent = statusText;

    console.log('Selected IDs:', Array.from(selectedImageIds));
}

// Function to create an image element
function createImageElement(image) {
    const img = document.createElement('img');
    const encodedPath = encodeURIComponent(image.original_path);
    img.src = `atom://${encodedPath}`;
    img.alt = image.file_name;
    img.title = `${image.file_name}\nID: ${image.id}\nMemo: ${image.memo || ''}`;
    img.dataset.imageId = image.id;

    // --- Enhanced Click Listener for Selection ---
    img.addEventListener('click', (event) => {
        const clickedId = parseInt(img.dataset.imageId, 10);
        const isCtrlPressed = event.ctrlKey || event.metaKey; // Ctrl (Win/Linux) or Cmd (Mac)
        const isShiftPressed = event.shiftKey;

        if (isShiftPressed && lastClickedImageElement) {
            // --- Shift+Click: Range Selection ---
            const lastClickedIndex = currentGridImages.indexOf(lastClickedImageElement);
            const clickedIndex = currentGridImages.indexOf(img);

            if (lastClickedIndex !== -1 && clickedIndex !== -1) {
                // Determine range start and end
                const startIndex = Math.min(lastClickedIndex, clickedIndex);
                const endIndex = Math.max(lastClickedIndex, clickedIndex);

                // If Ctrl is NOT pressed, clear previous selection first
                if (!isCtrlPressed) {
                    selectedImageIds.clear();
                }

                // Select images within the range
                for (let i = startIndex; i <= endIndex; i++) {
                    selectedImageIds.add(parseInt(currentGridImages[i].dataset.imageId, 10));
                }
            }
        } else if (isCtrlPressed) {
            // --- Ctrl/Cmd+Click: Toggle Selection ---
            if (selectedImageIds.has(clickedId)) {
                selectedImageIds.delete(clickedId);
            } else {
                selectedImageIds.add(clickedId);
            }
            // Update last clicked for potential Shift+Click next
            lastClickedImageElement = img;
        } else {
            // --- Simple Click: Select Only This ---
            selectedImageIds.clear();
            selectedImageIds.add(clickedId);
            // Update last clicked for potential Shift+Click next
            lastClickedImageElement = img;
        }

        updateSelectionVisuals(); // Update CSS classes based on the new selection set
    });

    // --- Double Click Listener for Actual Size Modal ---
    img.addEventListener('dblclick', () => {
        console.log('Double clicked image ID:', image.id, 'Path:', image.original_path);
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
        currentGridImages.push(imgElement);
    });
    imageGrid.appendChild(fragment);
}

// Function to populate the folder filter dropdown
async function populateFolderFilter() {
    console.log('Populating folder filter...');
    try {
        const result = await window.electronAPI.getDistinctFolders();
        if (result.success) {
            // Clear existing options except the first one ("All Folders")
            folderFilter.innerHTML = '<option value="">全てのフォルダ</option>';
            result.folders.forEach(folder => {
                const option = document.createElement('option');
                option.value = folder;
                option.textContent = folder; // Display the full path for now
                folderFilter.appendChild(option);
            });
            folderFilter.value = currentFolderFilter; // Restore previous selection if applicable
            console.log('Folder filter populated.');
        } else {
            console.error('Failed to get distinct folders:', result.message);
            // Handle error (e.g., disable filter?)
        }
    } catch (error) {
        console.error('Error calling getDistinctFolders:', error);
    }
}

// Function to populate the PNG word filter dropdown
async function populatePngWordFilter() {
    console.log('Populating PNG word filter...');
    try {
        const result = await window.electronAPI.getUniquePngWords();
        if (result.success) {
            pngWordFilter.innerHTML = '<option value="">全てのPNG単語</option>';
            result.words.forEach(word => {
                const option = document.createElement('option');
                option.value = word;
                option.textContent = word;
                pngWordFilter.appendChild(option);
            });
            pngWordFilter.value = currentPngWordFilter; // Restore previous selection
            console.log('PNG word filter populated.');
        } else {
            console.error('Failed to get unique PNG words:', result.message);
            // Handle error (e.g., disable filter?)
        }
    } catch (error) {
        console.error('Error calling getUniquePngWords:', error);
    }
}

// Function to load images (add folderPath parameter)
async function loadImages(offset = 0, limit = PAGE_SIZE, searchTerm = currentSearchTerm, folderPath = currentFolderFilter, pngWord = currentPngWordFilter) {
    if (isLoading || (offset > 0 && currentOffset >= totalImages)) {
        return;
    }
    console.log(`[loadImages] Attempting to load: offset=${offset}, limit=${limit}, term='${searchTerm}', folder='${folderPath}', pngWord='${pngWord}'`);
    isLoading = true;
    // Update loading message based on active filters
    let loadingMsg = '画像を読み込み中...';
    if (searchTerm) loadingMsg = `'${searchTerm}' を検索中...`;
    else if (pngWord) loadingMsg = `PNG単語 '${pngWord}' でフィルタ中...`;
    else if (folderPath) loadingMsg = `フォルダ '${folderPath}' を表示中...`;
    scanStatusParagraph.textContent = loadingMsg;

    try {
        let result;
        const options = { limit, offset };
        if (searchTerm) options.term = searchTerm;
        if (folderPath) options.folderPath = folderPath;
        if (pngWord) options.pngWord = pngWord; // Add pngWord to options

        // Call searchImages if any filter is active
        if (searchTerm || folderPath || pngWord) {
            console.log(`[loadImages] Calling window.electronAPI.searchImages...`, options);
            result = await window.electronAPI.searchImages(options);
        } else { // Otherwise call getImages
            console.log(`[loadImages] Calling window.electronAPI.getImages...`, options);
            result = await window.electronAPI.getImages(options);
        }
        console.log('[loadImages] Received result:', result);

        if (result.success) {
            // If it's a new search (offset is 0), clear the grid first
            if (offset === 0) {
                imageGrid.innerHTML = '';
                currentGridImages = [];
            }
            displayImages(result.images);
            currentOffset = offset + result.images.length; // Update offset correctly
            totalImages = result.total;

            // Update status bar text to reflect all active filters
            const searchStatus = searchTerm ? `'${searchTerm}' の検索` : '';
            const pngWordStatus = pngWord ? `PNG単語 '${pngWord}'` : '';
            const folderStatus = folderPath ? `フォルダ '${folderPath}' 内` : '全てのフォルダ';
            let baseStatus = '';
            if (searchStatus) baseStatus += searchStatus;
            if (pngWordStatus) baseStatus += (baseStatus ? ' + ' : '') + pngWordStatus;
            if (!searchStatus && !pngWordStatus) baseStatus = folderStatus;
            else if (folderPath) baseStatus += ` (${folderStatus})`;

            scanStatusParagraph.textContent = `${baseStatus}: ${currentOffset} / ${totalImages} 件`;

        } else {
            console.error('[loadImages] Failed to load/search images:', result.message);
            scanStatusParagraph.textContent = `エラー: ${result.message}`;
            // If search failed, maybe show all images?
             if (offset === 0) {
                 imageGrid.innerHTML = ''; // Clear grid on search error for offset 0
                 currentGridImages = [];
             }
        }
    } catch (error) {
        console.error('[loadImages] Error calling API or processing results:', error);
        scanStatusParagraph.textContent = 'データ取得中に予期せぬエラーが発生しました。';
    } finally {
        console.log(`[loadImages] Setting isLoading to false.`);
        isLoading = false;
    }
}

// --- Folder Filter Listener ---
folderFilter.addEventListener('change', () => {
    currentFolderFilter = folderFilter.value;
    console.log('Folder filter changed:', currentFolderFilter);
    // Reset pagination and reload images with the new filter
    currentOffset = 0;
    totalImages = 0;
    loadImages(0, PAGE_SIZE, currentSearchTerm, currentFolderFilter, currentPngWordFilter); // Pass pngWord filter too
});

// --- PNG Word Filter Listener ---
pngWordFilter.addEventListener('change', () => {
    currentPngWordFilter = pngWordFilter.value;
    console.log('PNG word filter changed:', currentPngWordFilter);
    // Reset pagination and reload images with the new filter
    currentOffset = 0;
    totalImages = 0;
    loadImages(0, PAGE_SIZE, currentSearchTerm, currentFolderFilter, currentPngWordFilter);
});

// --- Search Input Listener with Debounce ---
searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const searchTerm = searchInput.value.trim();
    debounceTimer = setTimeout(() => {
        console.log(`Search input changed: "${searchTerm}"`);
        currentSearchTerm = searchTerm;
        currentOffset = 0;
        totalImages = 0;
        // Pass both folder and pngWord filters to loadImages
        loadImages(0, PAGE_SIZE, currentSearchTerm, currentFolderFilter, currentPngWordFilter);
    }, 500);
});

// --- Infinite Scroll Logic ---
window.addEventListener('scroll', () => {
    const threshold = 300;
    if (!isLoading && currentOffset < totalImages &&
        (window.innerHeight + window.scrollY) >= document.body.offsetHeight - threshold)
    {   // Pass all filters
        console.log('Scroll threshold reached, loading more images for term:', currentSearchTerm, 'folder:', currentFolderFilter, 'pngWord:', currentPngWordFilter);
        loadImages(currentOffset, PAGE_SIZE, currentSearchTerm, currentFolderFilter, currentPngWordFilter);
    }
});

// Initial load
document.addEventListener('DOMContentLoaded', async () => { // Make async to await folder population
    console.log('[DOMContentLoaded] Event fired.');
    try {
        // Get Modal elements now that DOM is ready
        modalOverlay = document.getElementById('modal-overlay');
        modalImage = document.getElementById('modal-image');
        modalCloseButton = document.getElementById('modal-close-button');
        modalPngInfo = document.getElementById('modal-png-info');

        // Add modal close listeners now that elements are found
        if (modalCloseButton) {
            modalCloseButton.addEventListener('click', closeModal);
        } else {
            console.error('[DOMContentLoaded] modalCloseButton not found!');
        }
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (event) => {
                if (event.target === modalOverlay) {
                    closeModal();
                }
            });
        } else {
             console.error('[DOMContentLoaded] modalOverlay not found!');
        }

        // Reset grid and state
        imageGrid.innerHTML = '';
        currentGridImages = [];
        selectedImageIds.clear();
        lastClickedImageElement = null;
        currentOffset = 0;
        totalImages = 0;
        isLoading = false;
        currentSearchTerm = ''; // Ensure search term is clear on initial load
        searchInput.value = ''; // Clear search input visually
        currentFolderFilter = ''; // Reset folder filter
        folderFilter.value = ''; // Reset dropdown visually
        currentPngWordFilter = ''; // Reset PNG word filter state
        pngWordFilter.value = ''; // Reset PNG word dropdown visually

        // Populate filters initially
        await populateFolderFilter();
        await populatePngWordFilter(); // Populate PNG word filter

        console.log('[DOMContentLoaded] State reset. Calling loadImages...');
        loadImages(); // Load all images initially
        console.log('[DOMContentLoaded] loadImages() called.');
    } catch (error) {
        console.error('[DOMContentLoaded] Error during initial setup:', error);
    }
});

// When scan finishes, reload grid, clear search, AND update folder filter
window.electronAPI.onScanStatusUpdate(async (statusMessage) => { // Make async
  scanStatusParagraph.textContent = statusMessage;
  if (statusMessage.startsWith('完了:')) {
    console.log('Scan finished, clearing search, updating folders, and reloading image grid...');
    // ... reset state (grid, selection, pagination, search) ...
    currentFolderFilter = ''; // Reset folder filter state
    folderFilter.value = ''; // Reset dropdown visually
    currentPngWordFilter = ''; // Reset PNG word filter state
    pngWordFilter.value = ''; // Reset PNG word dropdown visually

    // Update folder list after scan
    await populateFolderFilter();

    loadImages(); // Reload all images
  }
});

// --- Add Delete Button Listener ---
deleteSelectedButton.addEventListener('click', async () => {
    const idsToDelete = Array.from(selectedImageIds);
    if (idsToDelete.length === 0) {
        console.warn('Delete button clicked, but no images selected.');
        return;
    }

    console.log('Requesting deletion for IDs:', idsToDelete);
    deleteSelectedButton.disabled = true; // Disable while processing
    scanStatusParagraph.textContent = '削除処理中...';

    try {
        const result = await window.electronAPI.deleteImages(idsToDelete);
        console.log('Delete result:', result);

        if (result.success) {
            scanStatusParagraph.textContent = result.message;
            // Remove deleted image elements from the grid
            currentGridImages = currentGridImages.filter(img => {
                const imgId = parseInt(img.dataset.imageId, 10);
                if (idsToDelete.includes(imgId)) {
                    img.remove(); // Remove from DOM
                    return false; // Remove from array
                }
                return true;
            });
            selectedImageIds.clear(); // Clear selection
            lastClickedImageElement = null;
            // Update total count (important for infinite scroll)
            totalImages -= result.deletedCount;
            updateSelectionVisuals(); // Update button state and status bar
        } else {
            // Show error message (e.g., user cancelled, DB error)
            scanStatusParagraph.textContent = `削除エラー: ${result.message}`;
            // Re-enable button if deletion failed but selection still exists
            deleteSelectedButton.disabled = selectedImageIds.size === 0;
        }
    } catch (error) {
        console.error('Error calling deleteImages:', error);
        scanStatusParagraph.textContent = '画像の削除中に予期せぬエラーが発生しました。';
        deleteSelectedButton.disabled = selectedImageIds.size === 0; // Re-enable button
    }
});

// Function to update the title attribute of an image element (optional)
function updateImageTitle(imageId, newMemo) {
    const imgElement = currentGridImages.find(img => parseInt(img.dataset.imageId, 10) === imageId);
    if (imgElement) {
        // Assuming title format: "filename\nID: id\nMemo: memo"
        const parts = imgElement.title.split('\n');
        if (parts.length >= 3) {
            imgElement.title = `${parts[0]}\n${parts[1]}\nMemo: ${newMemo || ''}`;
        }
    }
}

// --- Add Memo Update Button Listener ---
updateMemoButton.addEventListener('click', async () => {
    const idsToUpdate = Array.from(selectedImageIds);
    const newMemo = memoInput.value;

    if (idsToUpdate.length === 0) {
        console.warn('Update memo button clicked, but no images selected.');
        return;
    }

    console.log(`Requesting memo update for IDs: ${idsToUpdate.join(', ')} with memo: "${newMemo}"`);
    updateMemoButton.disabled = true; // Disable while processing
    memoInput.disabled = true;
    scanStatusParagraph.textContent = 'メモ更新中...';

    try {
        const result = await window.electronAPI.updateMemos({ imageIds: idsToUpdate, memo: newMemo });
        console.log('Memo update result:', result);

        if (result.success) {
            scanStatusParagraph.textContent = result.message;
            // Optionally update titles of affected images in the grid
            idsToUpdate.forEach(id => updateImageTitle(id, newMemo));
            // Clear memo input after successful update
            memoInput.value = '';
            // Re-enable based on selection (which hasn't changed)
            memoInput.disabled = selectedImageIds.size === 0;
            updateMemoButton.disabled = selectedImageIds.size === 0;
        } else {
            scanStatusParagraph.textContent = `メモ更新エラー: ${result.message}`;
            // Re-enable based on selection
            memoInput.disabled = selectedImageIds.size === 0;
            updateMemoButton.disabled = selectedImageIds.size === 0;
        }
    } catch (error) {
        console.error('Error calling updateMemos:', error);
        scanStatusParagraph.textContent = 'メモの更新中に予期せぬエラーが発生しました。';
        memoInput.disabled = selectedImageIds.size === 0;
        updateMemoButton.disabled = selectedImageIds.size === 0;
    }
});

// --- Add Export Button Listener ---
exportSelectedButton.addEventListener('click', async () => {
    const idsToExport = Array.from(selectedImageIds);
    if (idsToExport.length === 0) {
        console.warn('Export button clicked, but no images selected.');
        return;
    }

    console.log('Requesting export for IDs:', idsToExport);
    exportSelectedButton.disabled = true; // Disable while processing
    // Disable other action buttons too?
    deleteSelectedButton.disabled = true;
    updateMemoButton.disabled = true;
    memoInput.disabled = true;
    scanStatusParagraph.textContent = '選択した画像を保存中...';

    try {
        const result = await window.electronAPI.exportSelectedImages(idsToExport);
        console.log('Export result:', result);
        // Display result message in status bar regardless of success/failure
        scanStatusParagraph.textContent = result.message;
        // Optionally clear selection after export?
        // selectedImageIds.clear();
        // updateSelectionVisuals();

    } catch (error) {
        console.error('Error calling exportSelectedImages:', error);
        scanStatusParagraph.textContent = '画像の保存中に予期せぬエラーが発生しました。';
    } finally {
        // Re-enable buttons based on current selection state
        updateSelectionVisuals();
    }
});