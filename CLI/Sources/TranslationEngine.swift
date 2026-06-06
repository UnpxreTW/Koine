import Foundation

/// 翻譯引擎基礎層介面。
///
/// WIP 定義的 Day 1 抽象：v1 只實作 `AppleTranslationEngine`（Apple Translation Framework）。
/// 未來優化層（Foundation Models post-edit）走另一個 `TranslationRefiner` 協定、不在此。
///
/// 骨架階段先單句 `String` 簽名、對齊 Extension 的 `SafariWebExtensionHandler`；
/// 整篇批次（`translate(batch:)`）待 v1 後續擴充。
protocol TranslationEngine {
    func translate(
        _ text: String,
        from source: Locale.Language,
        to target: Locale.Language
    ) async throws -> String
}
