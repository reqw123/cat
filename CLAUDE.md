# 幻影殘卡（閃卡）專案規範

在 `C:\cat` 做閃卡（全息殘影卡）時照這份走。設計原理與景深細節見 `jimmy_phantom_card_設計說明.md`；桌面掛件／打包見 `桌面掛件說明.md`。

## 1. 這個專案是什麼

- 每張卡 = 一個**自包含 HTML**（圖片 base64 內嵌），放在 `cards/`，由桌面掛件 exe（Electron，`main.js`）與 `builder-gui` 打包。
- 統一架構是「吉米」那套：卡片外框、場景窗（模糊背景＋兩個染色殘影）、浮起的去背主體、全息膜、技能面板、卡背。新卡沿用它，只換配色、文字、圖片。

## 2. 做新卡：先選路線

| 情況 | 用什麼 |
|---|---|
| 一張角色圖／照片（預設路線，**不用生圖 API**） | `card-maker/make_card.py --params params.json`（去背、抽主色、推導配色、套模板） |
| 使用者明確要求生圖，或要「場景」與「主體」兩張獨立圖層 | 生圖後用 `card-maker/make_card_layers.py --params params.json`（見第 4 節） |

- 動漫角色去背用 rembg `isnet-anime`；照片／動物用 `isnet-general-use`；風景照沒有主體時用 `model: none`（整張照片當主體，**邊緣用圓角矩形羽化，不要橢圓**，橢圓會變舷窗）。
- Python 用 `C:\Users\homec\anaconda3\python.exe`（有 rembg、numpy、scipy、Pillow）。
- 輸出一律放 **`C:\cat\cards\` 最上層**（GUI 只掃描這一層、不遞迴；打包 exe 也只收這裡）。不要另開分支資料夾放「變體」，否則打包後功能不會生效。
- 檔名只用文字、數字、`_`、`-`（`slugify` 已處理）。含 `%` 等符號會讓打包後的 exe 載入失敗。
- 生成器會自動做：WebP 瘦身、card-fx 注入（稀有度切換／技能演出／卡背資訊／音效）、在 `card-fx/cards_meta.json` 登記編號與四項數值。

## 3. 卡片行為規範（使用者明確要求過）

- 主體要**框在金框內、對齊外框**，不要破框；主體在最上層、真 `translateZ`（小值，約 26～60px）、全彩高對比。下層（背景、殘影）半透明／退後。
- **可自由 360° 拖曳旋轉**、有卡背、雙擊翻面；放開時吸附回最近的整圈（不停在背面）；拖曳中加 `.spinning` 拿掉全息／濾鏡以免卡頓。
- 頂部標記（屬性晶片）與面板**不可用 `backdrop-filter`**（3D 旋轉時會失控），改用不透明漸層假裝玻璃；標記放在主體之上的 `translateZ`。
- `.card` 本身不能有 `filter`（會讓 `translateZ` 失效）；投影掛在 `.card__frame`。
- 自動翻面：卡內 `toggleAutoFlip`（L 鍵）；桌面掛件用全域快捷鍵 F4。不要遵守 `prefers-reduced-motion` 去關掉它。
- **任何新功能都必須在打包後的 exe／GUI 視窗裡生效**，不能只在單獨開啟的 HTML 生效。

## 4. 生圖 API（Gemini / Google AI Studio）

- **只有使用者明確提到要用生圖時才用。** 只給照片或現成圖片時，走第 2 節的預設路線，不呼叫 API。使用者沒提，就不要主動拿它生圖。
- 金鑰：變數名 `GEMINI_API_KEY`，在 `C:\Users\homec\.claude\settings.local.json` 的 `env` 區塊（**不是** Windows 環境變數，Claude Code 的 shell 環境裡也讀不到）。需要時自己去讀，不用問使用者。
- 讀取方式：用 JSON 解析（`json.load(...)["env"]["GEMINI_API_KEY"]`），在同一個行程裡使用。**絕不印出金鑰**：不要對該檔案跑 `Select-String`／`grep`，不要把值寫進任何檔案或輸出。顯示時只給變數名、長度、遮罩後的頭尾。
- 正式生圖前先做一次小呼叫確認金鑰有效（`card-maker/genai/gem.py models`）。目前可用圖像模型：`gemini-3.1-flash-image`（預設，約 10 秒一張）、`gemini-3-pro-image`（更精細）。
- 工具在 `card-maker/genai/`：`gem.py`（呼叫）、`gen_layers.py`（提示詞與分層）、`key_subject.py`（洋紅底去背）、`build_camp.py`（露營卡的範例建置腳本）。
- **API 不輸出真透明**，也別信畫出來的棋盤格。主體要請它畫在**純洋紅 `#FF00FF` 平坦背景**上，再用 `key_subject.py` 轉成真 alpha（核心遮罩＋邊緣色彩去汙；帶光暈的夜景主體要 `warm_fix`；日景有洋紅殘留用 `drop_pink`）。去背後一定要放到深色與淺色底上目檢邊緣。
- 場景圖用原照片當**構圖參考**（identity/composition），要求不含人物、文字、邊框；場景比例用 5:4 較貼近卡片窗口。
- **用使用者提供的照片／截圖當主體（不是憑空生圖）**時走兩步，每步都要看結果：① 清理（`gen_subjects.py clean`）：只叫模型去掉浮水印、文字橫幅、頁碼點、箭頭，並明講「其餘一律不准改」；低解析截圖會被重繪成約 1264px 寬，物件本體與配色都保持得很好。② 隔離（`gen_subjects.py iso`）：把主體放到洋紅底，模型會順手補完被畫面裁掉的邊（例如木棧前緣）。主體若被切得太寬（帳篷＋投影幕中間一大塊空白），用 `recompose_tent.py` 那種「只改位置、外觀不變」的重構提示，讓它們靠攏成約 4:3。道具本身的字（招牌、旗子）屬於主體，保留。
- 去背細節：主體含粉紅色物件（粉紅兔子）時不要開 `drop_pink`；有細金屬（三腳架）時把 `core_m` 放寬到約 120，再開 `edge_desat` 把邊緣粉暈降飽和。主體要配夜景背景時，只做輕微調色（變暗、偏藍），不改造型。
- 背景圖直接用使用者的原照片（`make_card_layers.py` 的 `scene`），主體浮在上面；日夜配對以氛圍為準，配對不確定時先說明假設。
- 提示詞、模型、後處理要寫進 `card-maker/output/<slug>/provenance.json`（`make_card_layers.py` 的 `notes` 欄位）；原始生成圖存 `output/<slug>/source/`。

## 5. 不可破壞的東西

- 使用者說「原檔要保留」時：新卡用**新檔名**，`overwrite` 保持 false；做完比對 `cards/` 既有檔案的 md5 確認沒被動到。
- 生成器會改 `card-fx/cards_meta.json`（新增登記）。正式生成前先備份，事後確認只是「新增」、既有條目沒變。
- 對既有卡片大量改寫（瘦身、批次 patch 等）要**先在獨立沙盒測試**（robocopy 出一份、junction `node_modules`），完整通過才套用到正式資料夾，並自動備份、驗證與沙盒輸出 byte-identical。專案已用 git 管理（`origin` = `github.com/reqw123/cat`，分支 `main`），`cards/` 等檔案可用 git 回滾；但 `node_modules/`、`dist/`、`build/`、`card-slim/backup/` 不在版控內，這幾個仍要自己備份。
- 不要動 `dist/`（使用者自己打包的 exe）；要測打包就輸出到暫存資料夾（`-c.directories.output=<scratch>`）。
- 不要 `rm -rf card-maker/output`：裡面有使用者用 GUI 生成的卡的中間檔。只清自己建立的測試資料夾。
- 測試打包後的 exe 時一律設 `LAUNCH_AT_LOGIN=false`，否則會改寫使用者的開機自啟登錄值。
- 殺測試用的 Electron／伺服器只能用 PID 或連接埠，不要用名稱（使用者還有別的 Electron 應用在跑）。

## 6. 驗證

- 瀏覽器驗證：在暫存資料夾開 `python -m http.server <port>`（claude-in-chrome 不能開 `file://`），用完關掉。Bash 工具每次呼叫 cwd 會重置，伺服器要在命令裡 `cd`。
- 至少確認：外觀（日／夜各看一次）、所有 `<img>` 解碼成功（`naturalWidth>0`）、拖曳旋轉、雙擊翻面到卡背、`window.toggleAutoFlip` 與 `window.cardFx` 存在。
- 改到桌面掛件或打包相關功能時，要真的啟動 exe／Electron 用真按鍵測，不能只看 DOM。
- 回報時如實說明：哪些有實測、哪些沒測（例如沒在打包 exe 裡試過），使用者需要在 builder-gui 重新打包才會帶入新卡。

## 7. 工具坑

- Windows PowerShell 5.1 讀無 BOM 的 UTF-8 `.ps1` 會把中文弄壞：`.ps1` 腳本保持純 ASCII，中文路徑用參數傳。
- 給 Bash 工具的 heredoc 會吃掉反斜線（Windows 路徑會壞）：寫 Python／JS 腳本用 Write 工具，或路徑用正斜線。
- Bash 終端機輸出中文可能是亂碼（編碼問題，不代表檔案壞了）；要確認中文檔名／鍵名用 PowerShell 或 Python 以 utf-8 讀。
