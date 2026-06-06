import Foundation
import Translation

/// Apple Translation Framework 實作（基礎層、v1）。
///
/// 走 macOS 26 standalone init `TranslationSession(installedSource:target:)`，無 SwiftUI
/// lifecycle 依賴——純 async，命令列環境可直接呼叫（WIP 研究：ar-ms.me 已實證純 async CLI
/// 跑通 standalone init）。API 形式對齊 Extension 的 `SafariWebExtensionHandler`、待實機校正。
///
/// 前提：來源 / 目標語言包須先於「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載；
/// 參數名 `installedSource` 即要求語言包已安裝，未裝會 throw、不會自動 prompt 下載。
struct AppleTranslationEngine: TranslationEngine {
    func translate(
        _ text: String,
        from source: Locale.Language,
        to target: Locale.Language
    ) async throws -> String {
        let session = TranslationSession(installedSource: source, target: target)
        let response = try await session.translate(text)
        return response.targetText
    }
}
