//
//  KoineCLI
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import ArgumentParser
import Foundation
import Koine

/// `koine` — 雅言命令列前端。
///
/// 同一介面供人類在終端機操作與自動化流程串接：譯文只走 stdout、診斷與錯誤走 stderr、
/// 非互動時絕不 prompt。`--json` opt-in 給需要結構化輸出的呼叫端。
@main
struct KoineCLI: AsyncParsableCommand {

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
		let source = Locale.Language(identifier: fromLanguage)
		let target = Locale.Language(identifier: toLanguage)
		// 預查語言組合：standalone init 不 throws、失敗會延到 translate 才爆出不可讀的
		// framework error——預查把兩種常見失敗轉成可行動訊息（文案與 bridge 共用 actionableMessage）。
		if let hint = (await engine.status(from: source, to: target))
			.actionableMessage(from: fromLanguage, to: toLanguage) {
			throw RuntimeError(hint)
		}
		let translated = try await engine.translate(input, from: source, to: target)
		if json {
			let payload = ["source": fromLanguage, "target": toLanguage, "text": translated]
			let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
			print(String(bytes: data, encoding: .utf8) ?? "")
		} else {
			print(translated)
		}
	}

	/// 位置參數優先；否則讀 stdin（管線 / 重導向）。空輸入回空字串、由呼叫端報錯。
	private func resolveInput() throws -> String {
		if let text {
			return text.trimmingCharacters(in: .whitespacesAndNewlines)
		}
		// 互動 TTY 且無位置參數：不會有管線輸入，直接報錯——
		// 否則 readDataToEndOfFile() 會無提示阻塞到 Ctrl-D、看起來像當機。
		guard isatty(FileHandle.standardInput.fileDescriptor) == 0 else {
			throw ValidationError("沒有輸入文字。提供位置參數或從 stdin 餵入。")
		}
		let data = FileHandle.standardInput.readDataToEndOfFile()
		guard !data.isEmpty else {
			return ""
		}
		// 區分「沒給輸入」與「給了但解不開」：非 UTF-8 不可吞成空字串誤報為無輸入。
		guard let input = String(bytes: data, encoding: .utf8) else {
			throw RuntimeError("輸入不是有效的 UTF-8 文字。")
		}
		return input.trimmingCharacters(in: .whitespacesAndNewlines)
	}
}
