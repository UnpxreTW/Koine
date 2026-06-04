# 雅言 Koine

> ⚠️ **Early WIP** — 專案剛起步、處於 PoC 階段，API 與架構可能大幅變動。

Apple 原生 on-device 翻譯 Safari Web Extension。

## 這是什麼

雅言是一個純 Apple 生態、資料不離機的網頁翻譯擴充：

- **基礎翻譯**用 Apple Translation Framework — 100% on-device、零成本、隱私第一
- **上下文優化**（規劃中）用 Foundation Models 在基礎譯文上潤飾 — 保留語氣、術語一致、不亂翻程式碼
- 整頁雙語對照，譯文排在原文下方

## 名稱

中文「**雅言**」出自《論語·述而》「子所雅言，詩、書、執禮，皆雅言也」，指周王朝的官話、當時各諸侯國通行的標準語 — 把讀不懂的外文，化成你能讀的雅言。

英文 **Koine**（希臘語 κοινή）是古地中海世界的通用語，與「雅言」概念對位：兩者都是讓人彼此讀懂的共同語言。

## 狀態

PoC 階段，核心翻譯路徑驗證中。

## 開發

專案用 [Tuist](https://tuist.dev) 生成，需要 Xcode 26+（iOS 26 SDK）：

```bash
mise install        # 取得釘住版本的 tuist
tuist generate      # 生成 Koine.xcworkspace
open Koine.xcworkspace
```
