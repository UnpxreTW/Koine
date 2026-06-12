// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: MPL-2.0
//
// 背景腳本：MV3 但用 background.scripts + persistent:false
// （Apple Dev Forum 工程師建議：iOS Safari 的 MV3 service_worker 不穩定）。
//
// 職責：把 content script 的翻譯請求轉給 native handler（SafariWebExtensionHandler）。
// 現階段用 sendNativeMessage 驗通路；後續改 connectNative long-lived port
// （sendNativeMessage 的 callback 在 iOS 不穩）。

browser.runtime.onMessage.addListener(async (message) => {
  try {
    const response = await browser.runtime.sendNativeMessage("application.id", message);
    return response;
  } catch (error) {
    console.error("[雅言] native message 失敗:", error);
    return { error: String(error) };
  }
});
