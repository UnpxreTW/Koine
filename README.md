# 雅言 Koine

> ⚠️ **Early WIP** — 專案剛起步、處於 PoC 階段，API 與架構可能大幅變動。

Apple 原生 on-device 翻譯 Safari Web Extension。

## 這是什麼

雅言是一個純 Apple 生態、隱私優先的網頁翻譯擴充：

- **基礎翻譯**用 Apple Translation Framework — 語言包下載後 100% on-device、零成本；未裝語言包即中止（不自動下載、不靜默回退雲端）
- **上下文優化**（規劃中）用 Foundation Models 在基礎譯文上潤飾 — 保留語氣、術語一致、不亂翻程式碼
- 整頁雙語對照，譯文排在原文下方

## 名稱

中文「**雅言**」出自《論語·述而》「子所雅言，詩、書、執禮，皆雅言也」，指周王朝的官話、當時各諸侯國通行的標準語 — 把讀不懂的外文，化成你能讀的雅言。

英文 **Koine**（希臘語 κοινή）是古地中海世界的通用語，與「雅言」概念對位：兩者都是讓人彼此讀懂的共同語言。

## 狀態

PoC 階段，核心翻譯路徑驗證中。

## 命令列工具 `koine`

擴充之外另有一支 macOS 命令列前端，與擴充共用同一條翻譯引擎路徑：

```bash
koine "Hello, world"              # 譯文走 stdout
echo "Hello, world" | koine       # 也吃 stdin
koine --json "Hello" --to ja      # 結構化輸出：source / target / text
koine --list-languages            # 本機支援的 BCP-47 語言代碼
```

語言包須先於「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載；未下載時工具會回可行動的提示，不自動下載、不回退雲端。

給自動化流程串接的兩個自省口（ArgumentParser 內建、不需額外安裝）：

```bash
koine --experimental-dump-help            # 完整介面 JSON（參數、預設值、說明）
koine --generate-completion-script zsh    # shell 補全腳本；--to / --from 會即時補語言代碼
```

## 開發

專案用 [Tuist](https://tuist.dev) 生成，需要 Xcode 26+（iOS 26 SDK）：

```bash
mise install        # 取得釘住版本的 tuist
tuist generate      # 生成 Koine.xcworkspace
open Koine.xcworkspace
```
