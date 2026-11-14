<h1 align="center">Breatic</h1>

<p align="center"><strong>為創意團隊打造的即時協作 AI 創作空間。</strong></p>
<p align="center">線上服務已開放 · 原始碼公開 · 桌面瀏覽器</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_zh_tw">官網</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_zh_tw">線上體驗</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">45秒英文示範</a> ·
  <a href="docs/USAGE.md">使用指南（英文）</a> ·
  <a href="https://discord.gg/Yeu6A4aejN">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/orime-org/breatic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/orime-org/breatic?style=flat&amp;color=blueviolet&amp;label=release&amp;display_name=tag"></a>
  <a href="LICENSE"><img alt="License: Elastic-2.0" src="https://img.shields.io/badge/license-Elastic--2.0-blue?style=flat"></a>
  <a href="https://discord.gg/Yeu6A4aejN"><img alt="Discord community" src="https://img.shields.io/badge/discord-join%20community-5865F2?style=flat&amp;logo=discord&amp;logoColor=white"></a>
  <a href="#get-started"><img alt="Quickstart guide" src="https://img.shields.io/badge/quickstart-guide-green?style=flat"></a>
</p>

<p align="center" dir="ltr">
  <a href="README.md">English</a> · <a href="README-CN.md">简体中文</a> · <strong>繁體中文</strong> · <a href="README-JA.md">日本語</a> · <a href="README-KO.md">한국어</a> · <a href="README-ES.md">Español</a> · <a href="README-PT-BR.md">Português</a><br>
  <a href="README-DE.md">Deutsch</a> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <a href="README-RU.md">Русский</a> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

將創作簡報、場景與媒體整理在同一個 Project。在 Document Spaces 中寫作，在 Canvas Spaces 中生成、調整素材，讓 AI Agent 與協作者在作品的脈絡中共同推進製作。

官方線上服務提供免費的 Starter 方案。AI 生成點數需另外購買，不包含在會員方案中。詳見[方案與點數定價][hosted-pricing]。

![Breatic 畫布上的咖啡店候選圖片與專案聊天；英文介面示例](docs/images/readme/workspace-en.png)

## 可以用它做什麼

| 功能 | 用途 |
| --- | --- |
| **一個 Project，多個 Spaces** | 用獨立分頁整理創作簡報、各場景與不同創意方向。 |
| **Document Spaces** | 使用標題、清單與格式化文字撰寫劇本、鏡頭描述及製作清單。 |
| **Canvas Spaces** | 在無限畫布排列參考資料與媒體，透過提示詞、模型與參考輸入生成及調整素材。 |
| **3D（DEV）** | 在共享場景中配置內建物件，調整位置、旋轉與縮放。 |
| **Timeline（DEV）** | 將 Project 影片或本機上傳影片編排在共享軌道上：移動、修剪、分割、複製和刪除片段，復原自己的編輯並預覽編排。描述一段網頁動畫，交給 DeepSeek 製作，在執行清單查看進度，再把結果作為片段加入軌道，按 Timeline 時鐘播放。各軌的影片和網頁動畫依圖層疊放、一起播放；在預覽中選取圖層即可移動、縮放、拉伸或旋轉，也可以輸入位置和大小。在播放列右端從 16:9、9:16、1:1、4:3、4:5、2:3、21:9 七種比例中選擇畫面比例，圖層在畫面中的相對位置保持不變。 |
| **專案中的 AI Agent** | 討論想法、提供文件或畫布脈絡，結合現有素材檢視提案。 |
| **即時協作** | 邀請協作者、設定存取權限，共同編輯同步的畫布、文件、3D 場景與 Timeline。 |

支援圖片、影片、音訊及 3D 素材；生成能力取決於已設定的供應商及模型存取權限。Canvas 與 Document 已可使用；3D 與 Timeline 標示為 **DEV**。Timeline 目前支援多條視訊軌上的影片和網頁動畫編輯與預覽，網頁動畫只在開啟該功能的部署中可用；更多媒體類型與影片匯出列為後續計畫。3D 場景中的模型生成與註解仍在開發中。

## 一起檢視與修改

讓決策留在作品旁邊。團隊比較兩張場景圖片時，協作者可直接修改共享的創作方向。Agent 可以先提出改寫提案，團隊檢視後再決定是否替換共享文件中的段落。

![共享創作方向與兩張場景圖片；英文介面示例](docs/images/readme/shared-direction.png)

![文件改寫提案及新增留言、取代操作；英文介面示例](docs/images/readme/agent-review.png)

圖片來自真實的示例專案；故事與場景素材用於說明操作。

## 創作流程：一支 30 秒咖啡店影片

**Studio** 管理專案與素材；**Project** 匯集一次製作；其中的 **Spaces** 依場景、交付內容或創意方向分配工作。

1. **撰寫簡報：** 在 Document Space 記下故事、受眾、對白與視覺方向。
2. **與 Agent 合作：** 將相關脈絡加入聊天，討論鏡頭並檢視提案。
3. **製作各個場景：** 在 Canvas Spaces 選擇已設定的模型、加入提示詞與參考資料，生成並比較不同版本。
4. **共同檢視與交付：** 與協作者選定素材，下載後用於製作。

可以將 Spaces 命名為「開場 · 0–10 秒」、「主場景 · 10–20 秒」、「結尾 · 20–30 秒」。這些名稱僅供規劃，不會設定片段時長或自動合成影片。使用 Timeline 編排及預覽，並在影片編輯器中完成整理與匯出。詳見[圖解示例（英文）](docs/USAGE.md#example-from-a-brief-to-a-visual)。

<a id="get-started"></a>

## 開始使用

- **官方線上服務：** 在桌面瀏覽器[開啟 Breatic][hosted-app]，註冊或登入。
- **自行架設：** 依照[個人與區域網路部署指南（英文）](self-host/LOCAL.md)操作。
- **開發與貢獻：** 參閱[開發環境設定（英文）](self-host/DEVELOPMENT.md)。

完成個人 Studio 設定，建立 Project，再用 **+** 新增 Document、Canvas、3D 或 Timeline Spaces。可先寫簡報、上傳參考資料或配置內建 3D 物件。[使用指南（英文）](docs/USAGE.md)包含[鍵盤快捷鍵](docs/USAGE.md#keyboard-shortcuts)。

### 自行架設之前

Web、API、背景工作及協作服務使用已發布的 Docker 映像，搭配 PostgreSQL 與 Redis。上傳與媒體處理由**你自己的 Cloudflare 帳戶**中的 Ingest Worker 與媒體容器執行，檔案存放在你的 R2 儲存桶；AI 呼叫使用你的供應商帳戶與額度。

這不是離線或完全地端部署。區域網路存取需要可信任的 HTTPS。雲端服務及模型呼叫可能產生費用；SMTP、Google 登入、Stripe 付款及搜尋是選用整合。請依指南設定並驗證雲端服務；初次使用 Node/pnpm/Wrangler 的步驟屬於部署，不代表日常使用需要啟動開發伺服器。

## 狀態、協助與貢獻

官方線上服務已開放並持續開發；上述 DEV 標記與功能範圍仍然適用。已發布的版本與說明請見 [Releases](https://github.com/orime-org/breatic/releases)。

[回報問題](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [建議功能](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

安全漏洞請依 [SECURITY.md](SECURITY.md) 私下回報。專案使用 TypeScript、React/Vite、Hono、PostgreSQL、Redis/BullMQ 與 Hocuspocus/Yjs，另有獨立的 Cloudflare Worker 處理上傳。

[貢獻流程](CONTRIBUTING.md) · [架構](docs/ARCHITECTURE.md) · [測試](docs/TEST-MANDATE.md)

[官網](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## 授權條款與允許用途

Breatic 原始碼公開，採用 [Elastic License 2.0](LICENSE)（Elastic-2.0）。你可以閱讀、修改、再散布，並自行使用或在所屬組織內部署，包括商業工作；不得將 Breatic 作為託管或代管服務提供給第三方。完整條件以授權條款為準。

Breatic 名稱與標誌是 Orime, Inc. 的商標，不包含在軟體授權中；使用規則見 [TRADEMARKS.md](TRADEMARKS.md)。授權條款不限制你使用 Breatic 創作的內容。

### 生成內容

每個實例的營運者與使用者須負責確保生成內容符合適用法律，包括著作權、商標、隱私、資料保護、名譽及內容管理；須擁有輸入資料及後續使用所需的權利，並依使用情境管理內容。Orime, Inc. 不保證生成內容的準確性、合法性、原創性或安全性。

第三方元件及聲明見 [THIRD-PARTY.md](THIRD-PARTY.md)。

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_zh_tw
[hosted-pricing]: https://breatic.ai/zh-TW/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_zh_tw

© 2026 Orime, Inc.
