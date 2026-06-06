import ArgumentParser
import Foundation

/// `koine` — 雅言命令列前端。
///
/// 同一介面服務人類與 AI 工具（Claude Code）：譯文只走 stdout、診斷與錯誤走 stderr、
/// 非互動時絕不 prompt。`--json` opt-in 給需要結構化輸出的呼叫端。
@main
struct Koine: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "koine",
        abstract: "雅言 — Apple Translation 的命令列前端（on-device、零成本）。",
        discussion: """
        從位置參數或 stdin 讀取文字，翻譯後將譯文輸出到 stdout。
        範例：
          koine "Hello, world"
          echo "Hello, world" | koine
          koine --json "Hello" --to ja
        """
    )

    @Argument(help: "要翻譯的文字；省略則從 stdin 讀取。")
    var text: String?

    @Option(name: [.customShort("t"), .customLong("to")], help: "目標語言（BCP-47），預設 zh-Hant。")
    var toLanguage: String = "zh-Hant"

    @Option(name: [.customShort("f"), .customLong("from")], help: "來源語言（BCP-47），預設 en。")
    var fromLanguage: String = "en"

    @Flag(help: "以 JSON 輸出（含來源 / 目標語言 / 譯文）。")
    var json = false

    func run() async throws {
        let input = try resolveInput()
        guard !input.isEmpty else {
            throw ValidationError("沒有輸入文字。提供位置參數或從 stdin 餵入。")
        }

        let engine = AppleTranslationEngine()
        let translated = try await engine.translate(
            input,
            from: Locale.Language(identifier: fromLanguage),
            to: Locale.Language(identifier: toLanguage)
        )

        if json {
            let payload = ["source": fromLanguage, "target": toLanguage, "text": translated]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            print(String(bytes: data, encoding: .utf8) ?? "")
        } else {
            print(translated)
        }
    }

    /// 位置參數優先；否則讀 stdin（管線 / 重導向）。兩者皆空回空字串、由呼叫端報錯。
    private func resolveInput() throws -> String {
        if let text {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let data = FileHandle.standardInput.readDataToEndOfFile()
        return (String(bytes: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
