# Electron Image Viewer

ローカルフォルダ内の画像を閲覧・管理するためのElectronアプリケーションです。

## 主な機能

*   指定したフォルダ内の画像ファイルをスキャンし、データベースに登録します。
*   サムネイル一覧表示（無限スクロール対応）
*   キーワード、フォルダ、PNGメタデータ（tEXt/iTXt/zTXtチャンク内のキーワード）、ID範囲による画像検索
*   画像のメタデータ（ファイルパス、サイズ、PNGテキストチャンク）表示
*   画像へのメモ追加・追記機能
*   選択した画像の削除
*   選択した画像のエクスポート
*   サムネイルのアスペクト比維持モード切り替え

## 使い方

1.  `npm install` で依存パッケージをインストールします。
2.  `npm start` でアプリケーションを起動します。
3.  初回起動時またはメニューの「ファイル」>「フォルダをスキャン」を選択し、画像が保存されているフォルダを選択します。
4.  スキャンが完了すると、画像がグリッド表示されます。
5.  画像をクリックすると選択（Ctrl/Cmd+クリックで複数選択、Shift+クリックで範囲選択）、ダブルクリックで拡大表示されます。
6.  検索バーにキーワードを入力すると、ファイル名やメモを対象に検索します。
7.  フィルタードロップダウンでフォルダやPNGキーワードによる絞り込みが可能です。
8.  ID範囲やソート順を指定して表示を調整できます。

### キーボードショートカット

*   **Sキー**: 選択中の画像にメモ入力欄の内容を追記します。
*   **Dキー**: 選択中の画像を削除します。（注意：削除操作は元に戻せません）

## ライセンス

このアプリケーションの利用には、同梱の `EULA.txt` に記載されたエンドユーザーライセンス契約への同意が必要です。

### 使用しているオープンソースソフトウェア

このアプリケーションは、以下のオープンソースソフトウェアを使用しています。各ソフトウェアのライセンス条項に従ってください。

*   **Electron** (MIT License): [https://github.com/electron/electron](https://github.com/electron/electron)
*   **better-sqlite3** (MIT License): [https://github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
*   **glob** (ISC License): [https://github.com/isaacs/node-glob](https://github.com/isaacs/node-glob)
*   **png-chunks-extract** (MIT License): [https://github.com/dyatko/png-chunks-extract](https://github.com/dyatko/png-chunks-extract)
*   **Sharp** (Apache License 2.0): 高性能な画像処理ライブラリです。
    *   リポジトリ: [https://github.com/lovell/sharp](https://github.com/lovell/sharp)
    *   npm: [https://www.npmjs.com/package/sharp](https://www.npmjs.com/package/sharp)

ライセンスの詳細については、各プロジェクトのWebサイトまたはリポジトリをご参照ください。 