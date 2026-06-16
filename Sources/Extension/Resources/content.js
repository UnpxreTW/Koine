// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// Content script — 注入每個頁面。

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
