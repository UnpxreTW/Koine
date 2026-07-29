//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import ArgumentParser
import CharacterizationSupport
import Foundation
import Testing

// MARK: - ParseCase

/// 單一參數組合的解析結果，收進批次 golden。
private struct ParseCase: Encodable {
	let arguments: String
	let outcome: String
}

// MARK: - KoineCLIInterfaceTests

/// `koine` 對外介面的特徵化：help 全文一張 golden、參數解析九案一張 golden。
///
/// 為什麼鎖 help 全文——`--experimental-dump-help`（機器可讀自省）與終端機說明由 ArgumentParser
/// 從同一份宣告產生，宣告即契約：預設值、旗標名、說明文案任一被無意改動，讀這份介面組參數的
/// 呼叫端就會靜默錯掉。golden 讓這類改動必須是刻意的（重錄 golden）而非順手的。
///
/// 兩張 golden 皆不觸發翻譯：只解析、不呼叫 `run()`，故不依賴語言包與 translationd。
private final class KoineCLIInterfaceTests {

	/// help 全文 golden。固定 `columns` 以免比對結果隨終端機寬度浮動。
	@Test
	private func `renders help text`() throws {
		try expectGolden(of: KoineCLI.helpMessage(includeHidden: false, columns: 100), as: .text)
	}

	/// 九案一次 golden：成功案記各欄位值、失敗案記 ArgumentParser 給使用者的訊息。
	@Test
	private func `parses argument combinations`() async throws {
		let argumentSets: [[String]] = [
			[],
			["Hello, world"],
			["--to", "ja", "Hello"],
			["-t", "ja", "-f", "de", "Hallo"],
			["--json", "Hello"],
			["--list-languages"],
			["--list-languages", "--json"],
			["--unknown-flag"],
			["--to"]
		]
		var cases: [ParseCase] = []
		for arguments in argumentSets {
			cases.append(
				ParseCase(arguments: arguments.joined(separator: " "), outcome: await outcome(parsing: arguments))
			)
		}
		try expectGolden(of: cases, as: .json)
	}

	/// 解析成功記欄位快照、失敗記 `KoineCLI.message(for:)`（即使用者實際看到的那句）。
	///
	/// 走 `asyncParse` 而非 `parse`：`--to` / `--from` 掛的是非同步自訂補全，
	/// 同步解析路徑遇到它會直接中止進程（ArgumentParser 的硬性檢查）。
	private func outcome(parsing arguments: [String]) async -> String {
		do {
			let command = try await KoineCLI.asyncParse(arguments)
			return [
				"text=\(command.text ?? "<nil>")",
				"from=\(command.fromLanguage)",
				"to=\(command.toLanguage)",
				"json=\(command.json)",
				"listLanguages=\(command.listLanguages)"
			].joined(separator: " ")
		} catch {
			return "failure: \(KoineCLI.message(for: error))"
		}
	}
}
