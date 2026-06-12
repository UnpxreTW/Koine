// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// Content script — 注入每個頁面。
// 現階段先做最小通路驗證：抓第一段文字送去翻譯、log 回傳結果。
// 後續換成整頁 DOM 三 Observer（TreeWalker + IntersectionObserver +
// MutationObserver）+ <font> wrapper 雙語對照。

(async () => {
  console.log("[雅言] content script loaded");

  const sample = document.querySelector("p")?.innerText?.trim();
  if (!sample) return;

  const result = await browser.runtime.sendMessage({
    type: "translate",
    text: sample,
    to: "zh-Hant",
  });
  console.log("[雅言] 翻譯結果:", result);
})();
