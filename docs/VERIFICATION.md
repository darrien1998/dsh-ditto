# Ditto 0.6.0 更新與驗證報告

驗證日期：2026-11-18（Asia/Taipei），Windows／Node.js 24.19.0。

- 完成 #6：樣本先取內容豐富模組，再優先涵蓋不同資料夾、語言與結構。迴歸 fixture 證明舊法三份皆為 routes，新法涵蓋三種資料夾角色；檢查輸入順序不影響結果及相似樣本避免重複。
- 完成 #8：兩個審閱頁加入 Alt + 上下方向鍵切換樣本、Alt + Shift + A 移至核准按鈕，再用原生 Enter／空白鍵執行。中英文提示、可見焦點、輸入／組字／連發／停用／忙碌保護均有 client-script 測試。
- 完整發布檢查通過：15 個測試檔、122 項測試、40 項 DSH 元件整合、schema 文件、效率比較、乾淨 tarball 安裝、真實 DSH rc.4 隔離 profile，以及執行期依賴稽核 0 漏洞。
- 30 模組合成傳輸比較仍為 71 → 28 次呼叫、約 252 KB → 55 KB JSON，兩條流程輸出一致、來源未變。未呼叫模型，不代表 token、費用、速度或語意品質改善。
- #3／#4／#5／#7 按產品範圍以 not planned 結案；#9 保留為真實使用與品質證據。理由見 [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)。
- 遠端 CI 與提交證據以 0.6.0 Release 附件 CI_RESULTS.json 為準。npm 驗證仍需有效登入；目前使用 GitHub tarball 安裝新版。

以下為歷史版本驗證紀錄。

---

# Ditto 0.5.0 更新與驗證報告

驗證日期：2026-11-18（Asia/Taipei）。Windows、Node.js 24.19.0。

## 本版完成

- 新增批次工作包、原子多份提交、精簡回傳、增量草稿重用、任務範本與本機效率報告，共 23 個原生工具。
- 完整模組證據受 bytes 上限控制；過大時明確要求分頁。上下文遺失後可重新取得，context id 不被當成模型記憶。
- 重用依來源與靜態相依內容、環境 manifest、指示、範本與核准樣本失效；新批次仍需樣本與最終核准，寫入前再次檢查環境。
- 新增 9 項原生宿主測試，完整套件為 13 個測試檔、115 項測試；保留既有檔案、安全、續跑與混合語言測試。
- 新增可重現效率測試並納入 CI：30 個合成模組，工具呼叫 71 → 28，JSON 回傳約 252 KB → 55 KB。兩條流程完整預覽、輸出相同、來源未變，未使用模型。原始結果見 [efficiency-result.json](efficiency-result.json)。這不是 token、費用、速度或語意品質量測。
- 本機完整發布檢查包含建置、115 項測試、DSH 元件、schema 文件、效率比較、乾淨打包、真實隔離 profile 與執行期稽核；遠端結果以本版 Release 所附 CI_RESULTS.json 及 Actions 為準。

## 發布與限制

GitHub 發行檔提供版本固定的可安裝 tarball 與 SHA-256；npm 發布需要有效登入，目前 `npm whoami` 回覆 E401，因此 README 明確使用 GitHub 0.5.0 資產，不讓使用者誤裝 npm 舊版。完整方法與快取範圍見 [EFFICIENCY.md](EFFICIENCY.md)。DSH dist-tags 查核仍為 latest 0.2.2-rc.1、next 0.2.2-rc.4、alpha 0.2.2-alpha.3。

以下保留 0.4 的歷史驗證紀錄；其中的工具數與測試數屬於該版。

---

# Ditto 0.4.0 更新與驗證報告

驗證日期：2026-11-18（Asia/Taipei）。環境：Windows、Node.js 24.19.0、npm 11.17.0、pnpm 11.25.0。

## 完成內容

- 將本機專案同步至上游 `492e82b`，納入原本缺少的 4 個提交，包括 Java adapter 與 CI 相容性修正。後續修改位於 `codex/dsh-latest-completion`。
- 專案版本更新為 **0.4.0**，開發元件固定使用 **DSH 0.2.2-rc.4 / Cordis 4.1.0**；Node.js 最低版本與新版 DSH 對齊為 **24.9.0**。
- 改用新版獨立原生執行器與批次工具呼叫介面，更新 TypeScript 7.0.2、Vitest 5.1.0、tsx 4.23.15 及 Node 24 型別。
- 新增 **`ditto_doctor`**，檢查正在執行的 profile、18 個工具、技能、資料夾與審批設定，不啟動 shell 或另一個宿主。
- 新增 **`doctor --json`**，修正新版 DSH 的獨立 CLI 套件解析診斷，拒絕無效 profile、越界 state、缺少選項值與未知選項，保留路徑中的等號。
- 補上 **Python** 文字探索與結構資訊、字串／註解遮罩、`.pyi` 排除，以及虛擬環境和快取資料夾排除。可與 Java、TypeScript／JavaScript 混合使用。
- 補上審批前與審批回覆後的取消檢查，避免已取消操作因延遲同意而繼續。
- 真實 profile smoke 必須驗證實際工具註冊、診斷成功及正確的作用中 profile；缺少 DSH／pnpm 會失敗。測試使用獨立 DSH_HOME，使用作業系統分配的空閒連接埠，並關閉瀏覽器自動開啟。
- 打包前自動建置，提供完整發布檢查命令，隔離各 smoke 的暫存套件以避免平行執行互相覆蓋。
- 更新中英文 README、相容性表、工具參考、安全對照、開發文件及 CI 設定。

## 已執行驗證

| 檢查 | 結果 |
|---|---|
| `npm run build` | 通過，TypeScript 嚴格編譯與宣告檔生成 |
| `npm test` | **12 個測試檔、106 項測試通過** |
| `npm run smoke:dsh` | 真實 Cordis、技能註冊與新版原生執行器；31 項整合測試通過 |
| DSH `0.2.2-alpha.3` canary | 隔離 worktree 中完成 106 項測試、元件整合、schema 文件及乾淨打包安裝驗證 |
| `npm run docs:tools -- --check` | 18 個工具的文件與即時 schema 一致 |
| `npm run smoke:tarball` | 乾淨安裝、18 個工具、原生診斷呼叫、CLI 示範、doctor 及卸載通過 |
| DSH `0.2.2-rc.1` tarball | 對 `latest` 通道的乾淨安裝與原生執行器診斷通過 |
| DSH `0.2.2-rc.4` 真實 profile | 安裝、配置組合、啟動、作用中診斷／工具註冊與獨立 CLI doctor 通過 |
| DSH `0.2.2-rc.1` 真實 profile | 透過 npm 隔離執行對應 launcher；同樣流程通過 |
| `npm run release:check:full` | 建置、測試、元件、文件、打包、真實 profile 與執行期依賴稽核通過 |
| `npm audit --omit=dev` | **0 個已知漏洞** |
| 16 模組示範 | 16/16 輸出完成、0 來源檔變更 |
| 混合語言測試 | Python／Java／TypeScript 取證、審閱、核准、套用與續跑通過，來源未執行或更動 |
| `git diff --check` | 通過 |

既有 174 檔批次、路徑／連結防護、RE2 規則、SQL／清單／checksum／ZIP、審批拒絕、版本摘要及續跑保護也保留在通過的測試套件內。CI 已設定 Ubuntu／Windows、Node 24／26，以及兩個 DSH profile 版本；本機只實際執行上述 Windows／Node 24 環境，不宣稱遠端 CI 已跑完。

## 可重現命令

```powershell
npm ci
npm run release:check:full
$env:DITTO_DSH_VERSION = '0.2.2-rc.1'
npm exec --yes --package=@deepseek-ai/dsh@0.2.2-rc.1 -- node scripts/profile-smoke.mjs
Remove-Item Env:DITTO_DSH_VERSION
```

以上 smoke 僅操作其暫存資料夾，不會安裝至既有使用者 profile。npm 套件庫發布另行管理；GitHub 的提交、CI 與發行狀態以 repository Actions 和 Releases 的即時紀錄為準。可安裝套件位於 `.local/release/dsh-ditto-0.4.0.tgz`，SHA-256 在同目錄的 `SHA256SUMS.txt`。

## 已知限制

- **開發依賴尚有上游漏洞**：完整 `npm audit` 回報 5 個 high 套件結果，根因為測試工具鏈中的 `picomatch` ReDoS，公告為 [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)。截至驗證日期，上游未提供已發布修補版本，因此沒有以降版或忽略稽核來掩蓋。執行期稽核為 0。
- 獨立 profile CLI 不會繼承 DSH 0.2 的宿主套件解析器，因此可能顯示無法掛載元件的警告。請在 DSH 內呼叫 `ditto_doctor` 查核實際註冊；真實 profile smoke 已在宿主內查核。
- Python／Java／TypeScript 的結構資訊是文字層級的近似提示，不是完整編譯器或語義正確保證；每項規格主張仍須通過原有證據引用驗證。
- 本次未呼叫模型或使用 API key。模型產出的內容品質仍由實際使用時的取證與人工審閱決定。
- DSH 0.1 與 Node 22 使用者須保留 Ditto 0.3；0.4 使用新版宿主 API。未來 DSH 發布版仍須重新驗證。
