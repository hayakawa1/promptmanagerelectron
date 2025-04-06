const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
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

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  // デバッグ用に開発者ツールを開く (オプション)
  // win.webContents.openDevTools();
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

// IPC ハンドラ (例)
ipcMain.handle('ping', () => 'pong');

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

// 画像情報を取得する IPC ハンドラ (フォルダフィルタ追加)
ipcMain.handle('get-images', async (event, { limit = 50, offset = 0, folderPath = null } = {}) => {
  console.log(`IPC: Received get-images request (limit=${limit}, offset=${offset}, folder='${folderPath}')`);
  try {
    let sql = `
      SELECT id, original_path, file_name, width, height, format, memo
      FROM images
    `;
    let countSql = 'SELECT COUNT(*) as total FROM images';
    const params = [];
    const countParams = [];

    if (folderPath) {
      sql += ' WHERE folder_path = ?';
      countSql += ' WHERE folder_path = ?';
      params.push(folderPath);
      countParams.push(folderPath);
    }

    sql += ' ORDER BY id ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const countStmt = db.prepare(countSql);

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

// 画像を検索する IPC ハンドラ (フォルダフィルタ追加)
ipcMain.handle('search-images', async (event, { term, limit = 50, offset = 0, folderPath = null } = {}) => {
  const searchTerm = term ? `%${term}%` : null;
  console.log(`IPC: Received search-images request (term='${term}', limit=${limit}, offset=${offset}, folder='${folderPath}')`);

  if (!searchTerm && !folderPath) {
      // Both empty, act like get-images without folder filter
      console.log('IPC: Search term and folder are empty, using get-images logic (all).');
      // Delegate to get-images (or just return all, similar logic)
      // For simplicity, just return empty, client should call get-images
       return { success: true, images: [], total: 0 };
  }

  try {
    let whereClauses = [];
    const params = [];
    const countParams = [];

    if (searchTerm) {
      whereClauses.push('(file_name LIKE ? OR memo LIKE ? OR png_info LIKE ?)');
      params.push(searchTerm, searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm, searchTerm);
    }
    if (folderPath) {
      whereClauses.push('folder_path = ?');
      params.push(folderPath);
      countParams.push(folderPath);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const searchSql = `
      SELECT id, original_path, file_name, width, height, format, memo
      FROM images
      ${whereSql}
      ORDER BY id ASC
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

    console.log(`IPC: Search returning ${images.length} images (total found: ${total})`);
    return { success: true, images: images, total: total };

  } catch (err) {
    console.error('IPC Error handling search-images:', err);
    return { success: false, message: `画像検索中にエラーが発生しました: ${err.message}`, images: [], total: 0 };
  }
});

// フォルダ選択と画像スキャン・DB登録を行う IPC ハンドラ
ipcMain.handle('select-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, message: 'ウィンドウが見つかりません。' };

  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    console.log('Folder selection cancelled.');
    return { success: false, message: 'フォルダ選択がキャンセルされました。' };
  }

  const folderPath = result.filePaths[0];
  console.log(`Selected folder: ${folderPath}`);

  let initialRegisteredCount = 0;
  let initialSkippedCount = 0;
  let metadataUpdatedCount = 0;
  let metadataErrorCount = 0;
  let pngInfoExtractedCount = 0;
  let pngInfoErrorCount = 0;
  let processedFilesForMetadata = 0;
  let processedFilesForPngInfo = 0;

  try {
    // --- 1. Initial Scan and Basic Info Registration ---
    win.webContents.send('scan-status-update', '画像ファイルを検索中...'); // Notify renderer
    const pattern = `${folderPath.replace(/\\/g, '/')}/**/*.@(${IMAGE_EXTENSIONS.join('|')})`;
    // Get only absolute paths (strings) from glob
    const imageFilePaths = await glob(pattern, { nocase: true, absolute: true });
    const totalFiles = imageFilePaths.length;
    win.webContents.send('scan-status-update', `${totalFiles} 件の画像ファイルを検出しました。基本情報を登録中...`);
    console.log(`Found ${totalFiles} image files.`);

    if (totalFiles === 0) {
      win.webContents.send('scan-status-update', '対象フォルダに画像ファイルが見つかりませんでした。');
      return { success: true, folderPath, fileCount: 0, message: '対象フォルダに画像ファイルが見つかりませんでした。' };
    }

    const insertStmt = db.prepare(`
      INSERT INTO images (original_path, file_name, folder_path, file_size, created_at_os, registered_at)
      VALUES (@original_path, @file_name, @folder_path, @file_size, @created_at_os, CURRENT_TIMESTAMP)
      ON CONFLICT(original_path) DO UPDATE SET
        file_name = excluded.file_name,
        folder_path = excluded.folder_path,
        file_size = excluded.file_size,
        -- created_at_os は基本的に更新しないか、必要に応じて更新ポリシーを検討
        registered_at = CURRENT_TIMESTAMP
    `);

    const registeredPaths = [];
    // Use transaction for bulk inserts
    const insertMany = db.transaction((paths) => {
      for (const filePath of paths) {
        // console.log('Processing file path:', filePath); // Keep for debugging if needed
        try {
          const stats = fs.statSync(filePath);
          // Check if it's a file
          if (!stats.isFile()) {
            console.log(`Skipping non-file: ${filePath}`);
            initialSkippedCount++;
            continue;
          }

          const fileName = path.basename(filePath);

          const fileData = {
            original_path: filePath,
            file_name: fileName,
            folder_path: path.dirname(filePath),
            file_size: stats.size,
            created_at_os: Math.floor(stats.birthtimeMs)
          };

          insertStmt.run(fileData);
          initialRegisteredCount++;
          registeredPaths.push(filePath); // Store path for metadata processing

        } catch (err) {
          // Handle errors like permission denied for fs.statSync or db insertion
          if (err.code === 'ENOENT') { // File might have been deleted between glob and stat
              console.warn(`File not found during stat, skipping: ${filePath}`);
          } else {
              console.error(`Failed to process file ${filePath}:`, err);
          }
          initialSkippedCount++;
        }
      }
    });

    // Execute the transaction
    insertMany(imageFilePaths);

    console.log(`Initial registration complete. Registered: ${initialRegisteredCount}, Skipped: ${initialSkippedCount}`);
    // Check if any files were actually registered before proceeding
    if (initialRegisteredCount === 0) {
        const finalMessage = `画像を登録/更新できませんでした。(${initialSkippedCount} 件スキップ)`;
        win.webContents.send('scan-status-update', `完了: ${finalMessage}`);
        return {
            success: true, // Technically the operation didn't fail, just found nothing to add
            folderPath,
            fileCount: totalFiles,
            registeredCount: 0,
            skippedCount: initialSkippedCount,
            metadataUpdatedCount: 0,
            metadataErrorCount: 0,
            pngInfoExtractedCount: 0,
            pngInfoErrorCount: 0,
            message: finalMessage
        };
    }
    win.webContents.send('scan-status-update', `基本情報の登録完了。メタデータ/PNG情報を取得中... (0/${initialRegisteredCount})`);

    // --- 2. Metadata & PNG Info Fetching and Update ---
    const updateMetaStmt = db.prepare(`
      UPDATE images
      SET width = @width,
          height = @height,
          format = @format,
          metadata_json = @metadata_json
          -- png_info は別のステップで更新
      WHERE original_path = @original_path
    `);
    const updatePngInfoStmt = db.prepare(`
      UPDATE images
      SET png_info = @png_info
      WHERE original_path = @original_path
    `);

    for (const filePath of registeredPaths) {
      let metaSuccess = false;
      let pngSuccess = false;

      // --- 2a. Fetch Metadata (sharp) ---
      try {
        const metadata = await sharp(filePath).metadata();
        const metaDataToStore = {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          // 必要に応じて他のメタデータを選択して JSON 文字列として保存
          metadata_json: JSON.stringify({
            space: metadata.space,
            channels: metadata.channels,
            depth: metadata.depth,
            density: metadata.density,
            isProgressive: metadata.isProgressive,
            hasProfile: metadata.hasProfile,
            hasAlpha: metadata.hasAlpha,
            orientation: metadata.orientation,
            exif: metadata.exif, // Buffer -> Base64 or similar if needed
            icc: metadata.icc,   // Buffer -> Base64 or similar if needed
            iptc: metadata.iptc, // Buffer -> Base64 or similar if needed
            xmp: metadata.xmp,   // Buffer -> Base64 or similar if needed
            // 必要ならさらに追加
          }),
          original_path: filePath,
        };
        updateMetaStmt.run(metaDataToStore);
        metadataUpdatedCount++;
        metaSuccess = true;
      } catch (err) {
        console.error(`Failed to get metadata for ${filePath}:`, err);
        metadataErrorCount++;
      }

      // --- 2b. Extract PNG Info (Using png-chunks-extract and manual decode) ---
      if (path.extname(filePath).toLowerCase() === '.png') {
        try {
          const buffer = await fsp.readFile(filePath);
          const chunks = extractChunks(buffer);
          const textChunks = [];

          for (const chunk of chunks) {
            const chunkName = chunk.name;
            const chunkData = Buffer.from(chunk.data);

            try {
              if (chunkName === 'tEXt') {
                const separatorIndex = chunkData.indexOf(0);
                if (separatorIndex !== -1) {
                  const keyword = safeDecode(chunkData.subarray(0, separatorIndex), 'latin1');
                  const text = safeDecode(chunkData.subarray(separatorIndex + 1), 'latin1');
                  textChunks.push({ keyword: keyword, text: text });
                }
              } else if (chunkName === 'zTXt') {
                const separatorIndex = chunkData.indexOf(0);
                if (separatorIndex !== -1 && chunkData[separatorIndex + 1] === 0) {
                  const keyword = safeDecode(chunkData.subarray(0, separatorIndex), 'latin1');
                  const compressedText = chunkData.subarray(separatorIndex + 2);
                  const decompressedText = zlib.inflateSync(compressedText);
                  const text = safeDecode(decompressedText, 'latin1');
                  textChunks.push({ keyword: keyword, text: text });
                }
              } else if (chunkName === 'iTXt') {
                let currentIndex = 0;
                const keywordEnd = chunkData.indexOf(0, currentIndex);
                if (keywordEnd === -1) continue;
                const keyword = safeDecode(chunkData.subarray(currentIndex, keywordEnd), 'latin1');
                currentIndex = keywordEnd + 1;
                if (currentIndex + 2 > chunkData.length) continue;
                const compressionFlag = chunkData[currentIndex];
                const compressionMethod = chunkData[currentIndex + 1];
                currentIndex += 2;
                const langTagEnd = chunkData.indexOf(0, currentIndex);
                if (langTagEnd === -1) continue;
                currentIndex = langTagEnd + 1;
                const transKeywordEnd = chunkData.indexOf(0, currentIndex);
                if (transKeywordEnd === -1) continue;
                currentIndex = transKeywordEnd + 1;
                let textData = chunkData.subarray(currentIndex);
                let text = '';
                if (compressionFlag === 1) {
                  if (compressionMethod === 0) {
                    try {
                      textData = zlib.inflateSync(textData);
                      text = safeDecode(textData, 'utf8');
                    } catch (inflateError) {
                      console.error(`Error decompressing iTXt chunk (${keyword}) for ${filePath}:`, inflateError);
                      continue;
                    }
                  } else {
                    console.warn(`Unsupported iTXt compression method (${compressionMethod}) for ${filePath} keyword '${keyword}'`);
                    continue;
                  }
                } else {
                  text = safeDecode(textData, 'utf8');
                }
                textChunks.push({ keyword: keyword, text: text });
              }
            } catch (decodeError) {
              console.error(`Error processing chunk ${chunkName} for ${filePath}:`, decodeError);
              // Continue processing other chunks
            }
          }

          if (textChunks.length > 0) {
            const pngText = textChunks.map(chunk => `${chunk.keyword}: ${chunk.text}`).join('\n\n');
            if (pngText) {
              updatePngInfoStmt.run({ png_info: pngText, original_path: filePath });
              pngInfoExtractedCount++;
              pngSuccess = true;
            }
          }
        } catch (err) {
          // Catch errors from readFile or chunk extraction
          console.error(`Failed to read or extract PNG chunks for ${filePath}:`, err);
          pngInfoErrorCount++;
        }
      }

      // --- Update Progress ---
      processedFilesForMetadata++; // Count processed files regardless of metadata/png success
      if (processedFilesForMetadata % 50 === 0 || processedFilesForMetadata === initialRegisteredCount) {
        win.webContents.send('scan-status-update',
          `メタデータ/PNG情報 取得中... (${processedFilesForMetadata}/${initialRegisteredCount})`
        );
      }
    }

    console.log(`Metadata update complete. Updated: ${metadataUpdatedCount}, Errors: ${metadataErrorCount}`);
    console.log(`PNG Info processing complete. Extracted: ${pngInfoExtractedCount}, Errors: ${pngInfoErrorCount}`);

    const finalMessage = 
      `${initialRegisteredCount} 件の画像登録/更新完了。
` +
      `メタデータ: ${metadataUpdatedCount}件更新 (${metadataErrorCount}件エラー)。
` +
      `PNG Info: ${pngInfoExtractedCount}件抽出 (${pngInfoErrorCount}件エラー)。
` +
      `${initialSkippedCount}件スキップ。`;

    win.webContents.send('scan-status-update', `完了: ${finalMessage}`);

    return {
      success: true,
      folderPath,
      fileCount: totalFiles,
      registeredCount: initialRegisteredCount,
      skippedCount: initialSkippedCount,
      metadataUpdatedCount,
      metadataErrorCount,
      pngInfoExtractedCount,
      pngInfoErrorCount,
      message: finalMessage
    };

  } catch (err) {
    console.error('Error during scan process:', err);
     win.webContents.send('scan-status-update', `エラーが発生しました: ${err.message}`);
    return { success: false, message: `処理中にエラーが発生しました: ${err.message}` };
  }
}); 