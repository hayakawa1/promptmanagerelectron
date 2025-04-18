const { app, BrowserWindow, ipcMain, dialog, protocol, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises'); // Import fs.promises
const Database = require('better-sqlite3');
const { glob } = require('glob');
const sharp = require('sharp'); // Import sharp
const extractChunks = require('png-chunks-extract');
const zlib = require('node:zlib'); // Import zlib

// Helper function from test_png.js
function safeDecode(buffer, encoding = 'latin1') {
  const cleanedBuffer = buffer.filter(byte => byte !== 0);
  return cleanedBuffer.toString(encoding);
}

// データベースファイルのパスをプロジェクトルートに変更
// const dbPath = path.join(app.getPath('userData'), 'file_db.sqlite');
const dbPath = path.join(__dirname, 'file_db.sqlite');
let db;

try {
  db = new Database(dbPath, { /* verbose: console.log */ }); // デバッグ時にログ出力する場合
  console.log('Database connected successfully:', dbPath);

  // テーブル作成 (存在しない場合のみ)
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_path TEXT UNIQUE NOT NULL,
      file_name TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      file_size INTEGER,
      created_at_os INTEGER, -- OS のファイル作成日時 (Unix タイムスタンプ)
      width INTEGER,
      height INTEGER,
      format TEXT,
      metadata_json TEXT,    -- sharp から取得した詳細メタデータ
      png_info TEXT,         -- PNG テキストチャンクの内容
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      memo TEXT,
      phash TEXT,            -- (将来用) 知覚ハッシュ
      parameter_hash TEXT    -- (将来用) パラメータハッシュ
    );
  `);
  console.log("Table 'images' ensured.");

  // インデックス作成 (検索パフォーマンスのため、必要に応じて追加)
  db.exec('CREATE INDEX IF NOT EXISTS idx_folder_path ON images (folder_path);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_file_name ON images (file_name);');

} catch (err) {
  console.error('Failed to connect or initialize database:', err);
  // エラー発生時の処理 (例: アプリケーション終了、エラー通知など)
  app.quit();
}

// 画像ファイルの拡張子リスト
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'];

let mainWindow; // Make win accessible globally or pass it around

function createWindow() {
  // Keep a reference to the window object
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

  // Optional: Open DevTools
  // mainWindow.webContents.openDevTools();

  // --- Create Application Menu ---
  const menuTemplate = [
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'フォルダをスキャン',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            // Send a message to the renderer process to trigger folder selection
            // Or call the handler logic directly if appropriate
            if (mainWindow) {
              mainWindow.webContents.send('trigger-folder-scan');
            }
          }
        },
        {
          type: 'separator'
        },
        {
          label: '終了',
          accelerator: 'CmdOrCtrl+Q',
          role: 'quit'
        }
      ]
    },
    // 表示メニューを追加
    {
        label: '表示',
        submenu: [
            { role: 'zoomIn', label: '拡大' },
            { role: 'zoomOut', label: '縮小' },
            { role: 'resetZoom', label: '実際のサイズ' },
            { type: 'separator' },
            // アスペクト比維持の切り替えメニューを追加
            {
                label: 'サムネイルのアスペクト比を維持',
                type: 'checkbox',
                checked: false, // 初期状態は OFF (固定高さ)
                click: (menuItem, browserWindow) => {
                    if (browserWindow) {
                        // レンダラープロセスに状態変更を通知
                        browserWindow.webContents.send('toggle-aspect-ratio', menuItem.checked);
                    }
                }
            },
            { type: 'separator' },
            { role: 'togglefullscreen', label: 'フルスクリーン切り替え' }
        ]
    },
    // Add other menus like '編集', '表示', 'ヘルプ' if needed
    {
      label: '開発', // For debugging
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
  // --- End Menu Creation ---
}

app.whenReady().then(() => {
  // Register atom:// protocol for safely loading local images
  protocol.registerFileProtocol('atom', (request, callback) => {
    try {
      // request.url will be like 'atom://C:/path/to/image.png'
      // Need to remove 'atom://' and decode the URI component
      const decodedPath = decodeURIComponent(request.url.substring('atom://'.length));
      // Security check: Ensure the path is absolute and normalize it
      if (path.isAbsolute(decodedPath)) {
        callback({ path: path.normalize(decodedPath) });
      } else {
        console.error('[Protocol] Denied request for non-absolute path:', request.url);
        // Respond with an error (e.g., file not found)
        callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
      }
    } catch (error) {
      console.error('[Protocol] Error handling request:', request.url, error);
      callback({ error: -2 }); // net::ERR_FAILED
    }
  });

  createWindow();

  app.on('activate', () => {
    // macOS で Dock アイコンがクリックされたときにウィンドウがなければ再作成する
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// すべてのウィンドウが閉じられたときの処理 (macOS を除く)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// アプリケーション終了時にデータベース接続を閉じる
app.on('will-quit', () => {
  if (db) {
    db.close();
    console.log('Database connection closed.');
  }
});

// データベースに登録されているユニークなフォルダパスを取得する IPC ハンドラ
ipcMain.handle('get-distinct-folders', async () => {
  console.log('IPC: Received get-distinct-folders request');
  try {
    const stmt = db.prepare('SELECT DISTINCT folder_path FROM images ORDER BY folder_path ASC');
    const folders = stmt.all().map(row => row.folder_path);
    console.log(`IPC: Returning ${folders.length} distinct folders`);
    return { success: true, folders };
  } catch (err) {
    console.error('IPC Error handling get-distinct-folders:', err);
    return { success: false, message: `フォルダ一覧の取得中にエラーが発生しました: ${err.message}`, folders: [] };
  }
});

// 画像情報を取得する IPC ハンドラ (フォルダフィルタ、IDフィルタ、ソート順追加)
ipcMain.handle('get-images', async (event, { limit = 50, offset = 0, folderPath = null, minId = null, maxId = null, sortOrder = 'ASC' } = {}) => {
  console.log(`IPC: Received get-images request (limit=${limit}, offset=${offset}, folder='${folderPath}', minId='${minId}', maxId='${maxId}', sort='${sortOrder}')`);
  try {
    let whereClauses = [];
    const params = [];
    const countParams = [];

    if (folderPath) {
      whereClauses.push('folder_path = ?');
      params.push(folderPath);
      countParams.push(folderPath);
    }
    if (minId !== null && !isNaN(minId)) {
        whereClauses.push('id >= ?');
        params.push(minId);
        countParams.push(minId);
    }
    if (maxId !== null && !isNaN(maxId)) {
        whereClauses.push('id <= ?');
        params.push(maxId);
        countParams.push(maxId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    // sortOrder のバリデーション (ASC or DESC)
    const validSortOrder = ('DESC' === sortOrder.toUpperCase()) ? 'DESC' : 'ASC';

    const sql = `
      SELECT id, original_path, file_name, width, height, format, memo
      FROM images
      ${whereSql}
      ORDER BY id ${validSortOrder}
      LIMIT ? OFFSET ?
    `;
    const countSql = `SELECT COUNT(*) as total FROM images ${whereSql}`;

    // Add limit and offset to params for the main query
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const countStmt = db.prepare(countSql);

    console.log('Executing Get SQL:', sql, 'Params:', params);
    console.log('Executing Count SQL:', countSql, 'Params:', countParams);

    const images = stmt.all(params);
    const { total } = countStmt.get(countParams);

    console.log(`IPC: Returning ${images.length} images (total: ${total})`);
    return { success: true, images: images, total: total };

  } catch (err) {
    console.error('IPC Error handling get-images:', err);
    return { success: false, message: `データベースからの画像取得中にエラーが発生しました: ${err.message}`, images: [], total: 0 };
  }
});

// 選択された画像のメモを一括更新する IPC ハンドラ
ipcMain.handle('update-memos', async (event, { imageIds, memo }) => {
  if (!imageIds || imageIds.length === 0) {
    return { success: false, message: 'メモを更新する画像が選択されていません。' };
  }
  const memoToSet = memo === null || memo === undefined ? '' : memo;
  console.log(`IPC: Received update-memos request for IDs: ${imageIds.join(', ')} with memo: "${memoToSet}"`);

  try {
    const placeholders = imageIds.map(() => '?').join(', ');
    const stmt = db.prepare(`UPDATE images SET memo = ? WHERE id IN (${placeholders})`);

    let changes = 0;
    const updateTransaction = db.transaction((ids, newMemo) => {
      const params = [newMemo, ...ids];
      const info = stmt.run(params);
      changes = info.changes;
    });
    updateTransaction(imageIds, memoToSet);

    console.log(`IPC: Updated memo for ${changes} images.`);
    return { success: true, updatedCount: changes, message: `${changes} 件の画像のメモを更新しました。` };

  } catch (err) {
    console.error('IPC Error handling update-memos:', err);
    return { success: false, message: `メモの更新中にエラーが発生しました: ${err.message}` };
  }
});

// 新しいIPCハンドラ: 選択された画像のメモにテキストを追記する
ipcMain.handle('append-memos', async (event, { imageIds, text }) => {
  if (!imageIds || imageIds.length === 0) {
    return { success: false, message: 'メモを追記する画像が選択されていません。' };
  }
  if (!text) {
    return { success: false, message: '追記するテキストが空です。' };
  }
  console.log(`IPC: Received append-memos request for IDs: ${imageIds.join(', ')} with text: "${text}"`);

  try {
    // トランザクション内で各画像のメモを取得して更新
    let updatedCount = 0;
    const appendTransaction = db.transaction((ids, appendText) => {
      const getStmt = db.prepare('SELECT memo FROM images WHERE id = ?');
      const updateStmt = db.prepare('UPDATE images SET memo = ? WHERE id = ?');
      const newMemos = {}; // 更新後のメモを保持するオブジェクト

      for (const id of ids) {
        const row = getStmt.get(id);
        if (row) {
          const currentMemo = row.memo || ''; // 既存メモが NULL なら空文字に
          // 既存メモが空でなく、かつ追記テキストと改行で連結
          const newMemo = currentMemo ? `${currentMemo}\n${appendText}` : appendText;
          const info = updateStmt.run(newMemo, id);
          if (info.changes > 0) {
            updatedCount++;
            newMemos[id] = newMemo; // 更新成功したIDと新しいメモを記録
          }
        } else {
          console.warn(`Append Memo: Image ID ${id} not found.`);
        }
      }
      return newMemos; // トランザクションから更新後のメモを返す
    });

    // appendTransaction の実行結果 (newMemos) を受け取る
    const updatedMemosMap = appendTransaction(imageIds, text);

    console.log(`IPC: Appended memo for ${updatedCount} images.`);
    // 返却値に newMemos を追加
    return { success: true, updatedCount: updatedCount, message: `${updatedCount} 件の画像のメモに追記しました。`, newMemos: updatedMemosMap };

  } catch (err) {
    console.error('IPC Error handling append-memos:', err);
    return { success: false, message: `メモの追記中にエラーが発生しました: ${err.message}` };
  }
});

// 選択された画像を削除する IPC ハンドラ
ipcMain.handle('delete-images', async (event, imageIds) => {
  if (!imageIds || imageIds.length === 0) {
    return { success: false, message: '削除する画像が選択されていません。' };
  }
  console.log(`IPC: Received delete-images request for IDs: ${imageIds.join(', ')}`);

  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, message: 'ウィンドウが見つかりません。' };

  // 確認ダイアログを表示
  const userChoice = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '削除の確認',
    message: `${imageIds.length} 件の画像をデータベースから削除します。よろしいですか？\n（元の画像ファイルは削除されません）`,
    buttons: ['はい (削除する)', 'いいえ (キャンセル)'],
    defaultId: 1, // Default to cancel
    cancelId: 1
  });

  if (userChoice.response === 1) { // ユーザーがキャンセルを選択
    console.log('IPC: Image deletion cancelled by user.');
    return { success: false, message: '削除はキャンセルされました。' };
  }

  // ユーザーが「はい」を選択した場合のみ削除を実行
  try {
    const placeholders = imageIds.map(() => '?').join(', ');
    const stmt = db.prepare(`DELETE FROM images WHERE id IN (${placeholders})`);

    let changes = 0;
    const deleteTransaction = db.transaction((ids) => {
      const info = stmt.run(ids);
      changes = info.changes;
    });
    deleteTransaction(imageIds);

    console.log(`IPC: Deleted ${changes} images from the database.`);
    return { success: true, deletedCount: changes, message: `${changes} 件の画像を削除しました。` };

  } catch (err) {
    console.error('IPC Error handling delete-images:', err);
    return { success: false, message: `画像の削除中にエラーが発生しました: ${err.message}` };
  }
});

// 選択された画像を別フォルダにコピーする IPC ハンドラ
ipcMain.handle('export-selected-images', async (event, imageIds) => {
  if (!imageIds || imageIds.length === 0) {
    return { success: false, message: '保存する画像が選択されていません。' };
  }
  console.log(`IPC: Received export-selected-images request for IDs: ${imageIds.join(', ')}`);

  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, message: 'ウィンドウが見つかりません。' };

  // 1. Get original paths from database
  let imagesToExport = [];
  try {
    const placeholders = imageIds.map(() => '?').join(', ');
    // SELECT original_path (we only need the path for copying)
    const stmt = db.prepare(`SELECT id, original_path FROM images WHERE id IN (${placeholders})`);
    imagesToExport = stmt.all(imageIds);
    if (imagesToExport.length === 0) {
      return { success: false, message: 'データベースに該当する画像が見つかりません。' };
    }
  } catch (dbError) {
    console.error('IPC Error getting paths for export:', dbError);
    return { success: false, message: `画像パスの取得中にエラーが発生しました: ${dbError.message}` };
  }

  // 2. Ask user for destination folder
  const destinationResult = await dialog.showOpenDialog(win, {
    title: '保存先フォルダを選択',
    properties: ['openDirectory', 'createDirectory'] // Allow creating new folders
  });

  if (destinationResult.canceled || destinationResult.filePaths.length === 0) {
    console.log('IPC: Export destination selection cancelled.');
    return { success: false, message: '保存先フォルダの選択がキャンセルされました。' };
  }
  const destinationPath = destinationResult.filePaths[0];
  console.log(`IPC: Export destination selected: ${destinationPath}`);

  // 3. Copy files
  let copiedCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const image of imagesToExport) {
    const sourcePath = image.original_path;
    const fileName = path.basename(sourcePath);
    const destFilePath = path.join(destinationPath, fileName);

    try {
      await fsp.copyFile(sourcePath, destFilePath); // Overwrites if exists
      console.log(`Copied ${sourcePath} to ${destFilePath}`);
      copiedCount++;
    } catch (copyError) {
      console.error(`Error copying ${sourcePath} to ${destFilePath}:`, copyError);
      errorCount++;
      errors.push(`${fileName}: ${copyError.message}`);
    }
    // Optional: Add progress update notification to renderer?
  }

  console.log(`IPC: Export finished. Copied: ${copiedCount}, Errors: ${errorCount}`);
  let message = `${copiedCount} 件の画像を ${destinationPath} に保存しました。`;
  if (errorCount > 0) {
    message += `\n${errorCount} 件のエラーが発生しました:
${errors.slice(0, 5).join('\n')} ${errorCount > 5 ? '...' : ''}`;
  }

  return {
    success: errorCount === 0, // Consider success only if no errors
    copiedCount: copiedCount,
    errorCount: errorCount,
    message: message
  };
});

// 特定の画像の PNG Info を取得する IPC ハンドラ
ipcMain.handle('get-png-info', async (event, imageId) => {
  if (!imageId) {
    return { success: false, message: '画像 ID が指定されていません。' };
  }
  console.log(`IPC: Received get-png-info request for ID: ${imageId}`);

  try {
    const stmt = db.prepare('SELECT png_info FROM images WHERE id = ?');
    const result = stmt.get(imageId);

    if (result) {
      console.log(`IPC: Returning PNG info for ID: ${imageId}`);
      return { success: true, pngInfo: result.png_info }; // png_info は null の可能性もある
    } else {
      console.log(`IPC: Image not found for ID: ${imageId}`);
      return { success: false, message: '画像が見つかりません。' };
    }
  } catch (err) {
    console.error(`IPC Error handling get-png-info for ID ${imageId}:`, err);
    return { success: false, message: `PNG Info の取得中にエラーが発生しました: ${err.message}` };
  }
});

// 特定の画像の Raw PNG Info を取得する IPC ハンドラ (デバッグ用)
ipcMain.handle('get-raw-png-info', async (event, imageId) => {
  if (!imageId) {
    return { success: false, message: '画像 ID が指定されていません。' };
  }
  console.log(`IPC: Received get-raw-png-info request for ID: ${imageId}`);

  try {
    // png_info カラムのみを選択
    const stmt = db.prepare('SELECT png_info FROM images WHERE id = ?');
    const result = stmt.get(imageId);

    if (result) {
      console.log(`IPC: Returning raw PNG info for ID: ${imageId}`);
      // 整形せずにそのまま返す
      return { success: true, rawPngInfo: result.png_info };
    } else {
      console.log(`IPC: Image not found for ID: ${imageId}`);
      return { success: false, message: '画像が見つかりません。' };
    }
  } catch (err) {
    console.error(`IPC Error handling get-raw-png-info for ID ${imageId}:`, err);
    return { success: false, message: `Raw PNG Info の取得中にエラーが発生しました: ${err.message}` };
  }
});

// 画像を検索する IPC ハンドラ (フォルダフィルタ、IDフィルタ、ソート順追加)
ipcMain.handle('search-images', async (event, {
        term, limit = 50, offset = 0, folderPath = null, pngWord = null,
        minId = null, maxId = null, sortOrder = 'ASC' // ID/Sort パラメータ追加
    } = {}) => {
  const searchTerm = term ? `%${term}%` : null;
  const searchPngWord = pngWord ? `%${pngWord}%` : null;
  console.log(`IPC: Received search-images request (term='${term}', pngWord='${pngWord}', limit=${limit}, offset=${offset}, folder='${folderPath}', minId='${minId}', maxId='${maxId}', sort='${sortOrder}')`); // Log 新パラメータ

  // Ensure at least one filter criteria is present (term, folder, pngWord, minId, maxId)
  if (!searchTerm && !folderPath && !searchPngWord && minId === null && maxId === null) {
      console.log('IPC: All filters are empty, using get-images logic (all).');
      // Delegate to get-images (but with sorting)
      return await ipcMain.handlers.get('get-images')(event, { limit, offset, sortOrder });
      // return { success: true, images: [], total: 0 }; // Or return empty
  }

  try {
    let whereClauses = [];
    const params = [];
    const countParams = [];

    if (searchTerm) {
      whereClauses.push('(file_name LIKE ? OR memo LIKE ?)');
      params.push(searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm);
    }
    if (searchPngWord) {
      // Search for the specific word within the png_info text
      whereClauses.push('png_info LIKE ?');
      params.push(searchPngWord);
      countParams.push(searchPngWord);
    }
    if (folderPath) {
      whereClauses.push('folder_path = ?');
      params.push(folderPath);
      countParams.push(folderPath);
    }
    // ID フィルター条件を追加
    if (minId !== null && !isNaN(minId)) {
        whereClauses.push('id >= ?');
        params.push(minId);
        countParams.push(minId);
    }
    if (maxId !== null && !isNaN(maxId)) {
        whereClauses.push('id <= ?');
        params.push(maxId);
        countParams.push(maxId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    // sortOrder のバリデーション (ASC or DESC)
    const validSortOrder = ('DESC' === sortOrder.toUpperCase()) ? 'DESC' : 'ASC';

    const searchSql = `
      SELECT id, original_path, file_name, width, height, format, memo
      FROM images
      ${whereSql}
      ORDER BY id ${validSortOrder}
      LIMIT ? OFFSET ?
    `;
    const countSql = `SELECT COUNT(*) as total FROM images ${whereSql}`;

    // Add limit and offset to params for the main query
    params.push(limit, offset);

    const stmt = db.prepare(searchSql);
    const countStmt = db.prepare(countSql);

    console.log('Executing Search SQL:', searchSql, 'Params:', params);
    console.log('Executing Count SQL:', countSql, 'Params:', countParams);

    const images = stmt.all(params);
    const { total } = countStmt.get(countParams);

    console.log(`IPC: Returning ${images.length} search results (total: ${total})`);
    return { success: true, images: images, total: total };

  } catch (err) {
    console.error('IPC Error handling search-images:', err);
    return { success: false, message: `画像検索中にエラーが発生しました: ${err.message}`, images: [], total: 0 };
  }
});

// Add an IPC listener in the main process to handle the menu click event
ipcMain.handle('select-folder-from-menu', async () => {
  if (!mainWindow) return { success: false, message: 'メインウィンドウが見つかりません。' };
  // Reuse the selectFolder logic
  return await selectFolder(mainWindow);
});

// Modified selectFolder to be callable from menu (pass window object)
async function selectFolder(targetWindow) {
  if (!targetWindow) {
    console.error('[selectFolder] Error: targetWindow is missing');
    return { success: false, message: '操作対象のウィンドウが見つかりません。' };
  }
  console.log('[selectFolder] Called');
  targetWindow.webContents.send('scan-status-update', 'フォルダ選択ダイアログを開いています...');

  const result = await dialog.showOpenDialog(targetWindow, {
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    console.log('[selectFolder] Folder selection cancelled');
    targetWindow.webContents.send('scan-status-update', 'フォルダ選択がキャンセルされました。');
    return { success: false, cancelled: true };
  }

  const folderPath = result.filePaths[0];
  console.log('[selectFolder] Selected folder:', folderPath);
  targetWindow.webContents.send('scan-status-update', `フォルダ ${folderPath} のスキャンを開始します...`);

  // スキャン処理を非同期で開始
  scanDirectory(folderPath, targetWindow); // Pass window to update status

  return { success: true, path: folderPath };
}

// Modified scanDirectory to accept window object for status updates
async function scanDirectory(dirPath, targetWindow) {
  // ... (rest of the scanDirectory logic remains the same,
  //        but use targetWindow.webContents.send instead of event.sender)

  let processedCount = 0;
  let addedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let totalFiles = 0;

  try {
    const pattern = `**/*.{${IMAGE_EXTENSIONS.join(',')}}`;
    console.log(`Scanning directory: ${dirPath} with pattern: ${pattern}`);
    targetWindow.webContents.send('scan-status-update', `ファイル一覧を取得中: ${dirPath}`);

    const files = await glob(pattern, {
      cwd: dirPath,
      absolute: true,
      nocase: true,
      follow: false, // シンボリックリンクは追わない
      nodir: true, // ディレクトリ自体は結果に含めない
      ignore: '**/node_modules/**' // node_modulesを除外
    });
    totalFiles = files.length;
    console.log(`Found ${totalFiles} potential image files.`);
    targetWindow.webContents.send('scan-status-update', `${totalFiles} 件の候補ファイルを検出。処理を開始します...`);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO images
        (original_path, file_name, folder_path, file_size, created_at_os, width, height, format, metadata_json, png_info)
      VALUES (@original_path, @file_name, @folder_path, @file_size, @created_at_os, @width, @height, @format, @metadata_json, @png_info)
    `);

    const insertMany = db.transaction((images) => {
      let localAddedCount = 0;
      for (const imgData of images) {
        try {
            const info = insertStmt.run(imgData);
            if (info.changes > 0) {
                localAddedCount++;
            }
        } catch (err) {
            console.error(`Error inserting image ${imgData.original_path}:`, err);
            errorCount++;
        }
      }
      return localAddedCount;
    });

    const batchSize = 100; // Process files in batches
    for (let i = 0; i < files.length; i += batchSize) {
        const batchFiles = files.slice(i, i + batchSize);
        const batchData = [];

        await Promise.all(batchFiles.map(async (filePath) => {
            processedCount++;
            try {
                const absolutePath = path.resolve(filePath);
                const normalizedPath = path.normalize(absolutePath);
                const fileName = path.basename(normalizedPath);
                const folderPath = path.dirname(normalizedPath);

                // 1. Get file stats
                const stats = await fsp.stat(normalizedPath);
                const fileSize = stats.size;
                // Electronではms単位だが、Unixタイムスタンプ(秒)に変換
                const createdAtOs = Math.floor(stats.birthtimeMs / 1000);

                // 2. Get image metadata using sharp
                let metadata = {};
                let sharpError = null;
                try {
                  metadata = await sharp(normalizedPath).metadata();
                } catch (err) {
                    console.warn(`Sharp could not read metadata for ${normalizedPath}: ${err.message}`);
                    sharpError = err;
                }

                // Check if metadata extraction was successful
                if (!metadata || !metadata.format || !metadata.width || !metadata.height) {
                    console.warn(`Skipping ${normalizedPath} due to missing essential metadata (format, width, height). Sharp error: ${sharpError?.message}`);
                    skippedCount++;
                    return; // Skip this file if essential data is missing
                }

                // 3. Extract PNG text chunks (if applicable)
                let pngInfoText = null;
                if (metadata.format === 'png') {
        try {
                        const pngBuffer = await fsp.readFile(normalizedPath);
                        const chunks = extractChunks(pngBuffer);
                        const textChunks = chunks.filter(chunk => chunk.name === 'tEXt' || chunk.name === 'iTXt' || chunk.name === 'zTXt');
                        pngInfoText = textChunks.map(chunk => {
                            let key = '';
                            let value = '';
                            let separatorIndex = -1;

                            if (chunk.name === 'tEXt') {
                                separatorIndex = chunk.data.indexOf(0); // Null separator
                if (separatorIndex !== -1) {
                                    key = safeDecode(chunk.data.slice(0, separatorIndex), 'latin1');
                                    value = safeDecode(chunk.data.slice(separatorIndex + 1), 'latin1');
                }
                            } else if (chunk.name === 'zTXt') {
                                separatorIndex = chunk.data.indexOf(0);
                                if (separatorIndex !== -1 && chunk.data[separatorIndex + 1] === 0) { // 0 = compression method deflate
                                    key = safeDecode(chunk.data.slice(0, separatorIndex), 'latin1');
                                    try {
                                        const compressedValue = chunk.data.slice(separatorIndex + 2);
                                        value = safeDecode(zlib.inflateSync(compressedValue), 'utf8');
                                    } catch (e) {
                                        console.warn(`Failed to decompress zTXt chunk for ${normalizedPath}: ${e.message}`);
                                        value = '[decompression error]';
                                    }
                }
                            } else if (chunk.name === 'iTXt') {
                                separatorIndex = chunk.data.indexOf(0);
                                if (separatorIndex !== -1) {
                                    key = safeDecode(chunk.data.slice(0, separatorIndex), 'latin1');
                                    // iTXt format: key\0compFlag\0compMethod\0langTag\0transKey\0value
                                    // We are simplifying here, just trying to find the value part
                                    const fields = [];
                                    let current = separatorIndex + 1;
                                    while (current < chunk.data.length) {
                                        let nextNull = chunk.data.indexOf(0, current);
                                        if (nextNull === -1) nextNull = chunk.data.length;
                                        fields.push(chunk.data.slice(current, nextNull));
                                        current = nextNull + 1;
                                    }
                                    // Assuming value is the last field and potentially compressed
                                    if (fields.length >= 4) {
                                        const compFlag = fields[0][0];
                                        const compMethod = fields[1][0];
                                        const langTag = safeDecode(fields[2], 'utf8');
                                        const transKey = safeDecode(fields[3], 'utf8');
                                        const rawValue = fields[4] || Buffer.alloc(0);

                                        if (compFlag === 1 && compMethod === 0) { // Compressed with deflate
                                            try {
                                                value = safeDecode(zlib.inflateSync(rawValue), 'utf8');
                                            } catch (e) {
                                                 console.warn(`Failed to decompress iTXt chunk for ${normalizedPath}: ${e.message}`);
                                                 value = '[decompression error]';
                    }
                                        } else if (compFlag === 0) { // Not compressed
                                            value = safeDecode(rawValue, 'utf8');
                                        } else {
                                            value = '[unsupported compression]';
                                        }
                                    }
                                }
                            }
                            // Limit key/value length to prevent huge strings
                            const MAX_LEN = 200;
                            const displayKey = key.length > MAX_LEN ? key.substring(0, MAX_LEN) + '...' : key;
                            const displayValue = value.length > MAX_LEN ? value.substring(0, MAX_LEN) + '...' : value;
                            return `${chunk.name}: ${displayKey}=${displayValue}`;
                        }).join('\n');
                    } catch (err) {
                        console.error(`Could not extract PNG chunks for ${normalizedPath}: ${err.message}`);
                    }
                }

                // 4. Prepare data for insertion
                const imageRecord = {
                    original_path: normalizedPath,
                    file_name: fileName,
                    folder_path: folderPath,
                    file_size: fileSize,
                    created_at_os: createdAtOs,
                    width: metadata.width,
                    height: metadata.height,
                    format: metadata.format,
                    metadata_json: JSON.stringify(metadata), // Store all sharp metadata
                    png_info: pngInfoText // Store extracted text chunks
                };
                batchData.push(imageRecord);

            } catch (err) {
                console.error(`Error processing file ${filePath}:`, err);
                errorCount++;
        }
            // Update progress every file
            if (processedCount % 10 === 0 || processedCount === totalFiles) { // Update less frequently
                targetWindow.webContents.send('scan-status-update', `処理中 ${processedCount}/${totalFiles} (追加: ${addedCount}, スキップ: ${skippedCount}, エラー: ${errorCount})`);
      }
        }));

        // Insert the batch data into the database
        if (batchData.length > 0) {
            const batchAdded = insertMany(batchData);
            addedCount += batchAdded;
            console.log(`Inserted batch [${i}-${i+batchSize-1}], added: ${batchAdded}`);
        }
    }

    console.log(`Scan finished for ${dirPath}. Total: ${totalFiles}, Added: ${addedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
    targetWindow.webContents.send('scan-status-update', `完了: ${addedCount} 件の新規画像を追加 (スキップ: ${skippedCount}, エラー: ${errorCount})`);

  } catch (err) {
    console.error(`Error scanning directory ${dirPath}:`, err);
    targetWindow.webContents.send('scan-status-update', `エラー: スキャン中に問題が発生しました - ${err.message}`);
  }
}

// Function to get unique words from png_info (Improved for Stable Diffusion format)
function getUniquePngWords() {
  try {
    const stmt = db.prepare('SELECT DISTINCT png_info FROM images WHERE png_info IS NOT NULL AND png_info != \'\'');
    const results = stmt.all();
    const wordSet = new Set();
    // 区切り文字: カンマ、空白、改行
    const separators = /[\s,;\n]+/;

    results.forEach(row => {
      if (row.png_info) {
        // デバッグ用 console.log は削除
        // console.log(`[Debug] Raw png_info from DB (getUniquePngWords): Content:\n${row.png_info}`);

        let relevantText = row.png_info;

        // "tEXt: ..." 形式のような、デコードされていないデータはスキップ
        if (relevantText.startsWith('tEXt:')) {
             // console.log('[Debug] Skipping tEXt chunk-like data.');
             return; // 次のレコードへ
        }

        // 主要なメタデータ行 (Steps:, Sampler:, etc.) を除外し、
        // プロンプト/ネガティブプロンプト部分を抽出する試み
        const lines = relevantText.split('\n');
        let processedText = lines.filter(line => {
             // メタデータ行を除外 (より多くのキーを追加)
             if (/^(parameters:|steps:|sampler:|cfg scale:|seed:|size:|model hash:|model:|denoising strength:|lora hashes:|version:|adetailer|hires|mask blur:|clip skip:|ensd:)/i.test(line.trim())) {
                 return false;
             }
             // Negative prompt: 行自体は含めない (その後の行は含む)
             if (/^negative prompt:/i.test(line.trim())) {
                 return false;
             }
             return true; // それ以外の行を対象とする
        }).join('\n'); // 再度文字列に結合

        // 括弧、山括弧、数値重み(:1.2など)、BREAKキーワード、クォートを除去
        processedText = processedText
            .replace(/[\(\)<>\[\]]/g, ' ')      // 括弧、山括弧、角括弧をスペースに
            .replace(/:\d+(\.\d+)?/g, ' ')     // :1.2 のような重みをスペースに
            .replace(/\bBREAK\b/gi, ' ')       // BREAK キーワードをスペースに (大文字小文字無視)
            .replace(/["'`]/g, ' ');           // クォート類をスペースに

        const words = processedText.split(separators)
            .map(word => {
                // 前後の不要な文字(空白、記号など)を除去し、小文字化
                let cleanedWord = word.trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''); // 先頭末尾の非英数字を除去
                // 必要であればさらに不要な文字を除去 (アンダースコアは残す場合が多いので注意)
                // cleanedWord = cleanedWord.replace(/[^a-zA-Z0-9_ -]/g, '');
                return cleanedWord.toLowerCase();
            })
            // 意味のある単語のみを対象とする
            .filter(word =>
                word &&                  // 空でない
                word.length > 1 &&       // 長さ2以上
                !/^\d+$/.test(word) &&    // 数字のみでない
                /[a-zA-Z]/.test(word)   // 最低1文字はアルファベットを含む (記号のみや数字+記号を除外)
            );

        words.forEach(word => wordSet.add(word));
      }
    });

    console.log(`Found ${wordSet.size} unique words in PNG info (Improved).`);
    return { success: true, words: Array.from(wordSet).sort() };

  } catch (err) {
    console.error('Error getting unique PNG words:', err);
    return { success: false, message: `PNG Info単語の取得中にエラー: ${err.message}`, words: [] };
  }
}

ipcMain.handle('get-unique-png-words', async () => {
  return getUniquePngWords();
}); 