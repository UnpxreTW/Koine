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
///
/// 介面自省由 ArgumentParser 從本宣告直接產生，不需另寫維護品：
/// `--experimental-dump-help` 輸出完整介面 JSON、`--generate-completion-script <shell>` 產補全腳本。
/// 因此本型別的 help 文案即對外契約——它同時是終端機說明、JSON 自省內容與補全描述的單一出處。
///
/// 進入點不在本型別上（見 `Entry.swift`），讓命令定義能一併編進測試 target 做介面特徵化。
struct KoineCLI: AsyncParsableCommand {

	static let configuration = CommandConfiguration(
		commandName: "koine",
		abstract: "雅言 — Apple Translation 的命令列前端（on-device、零成本）。",
		discussion: """
		從位置參數或 stdin 讀取文字，翻譯後將譯文輸出到 stdout；診斷與錯誤走 stderr。
		互動終端機下未給位置參數會直接報錯，不會靜默等待輸入。

		範例：
		  koine "Hello, world"
		  echo "Hello, world" | koine
		  koine --json "Hello" --to ja
		  koine --list-languages

		語言代碼採 BCP-47。`--list-languages` 列出本機支援的代碼；帶書寫系統的寫法
		（如 zh-Hant）同樣接受。支援不等於可用——語言包須先於「系統設定 → 一般 →
		語言與地區 → 翻譯語言」下載，未下載時本工具會回可行動的提示、不會自動下載。

		--json 的輸出：翻譯時為物件，三鍵 source / target / text；
		搭配 --list-languages 時為物件，單鍵 languages（代碼字串陣列）。

		介面自省：`koine --experimental-dump-help` 輸出完整介面 JSON、
		`koine --generate-completion-script zsh` 產 shell 補全腳本。
		"""
	)

	@Argument(help: "要翻譯的文字；省略則從 stdin 讀取。")
	var text: String?

	@Option(
		name: [.customShort("t"), .customLong("to")],
		help: "目標語言（BCP-47），預設 zh-Hant。",
		completion: .custom { _, _, _ in await AppleTranslationEngine().supportedLanguages() }
	)
	var toLanguage: String = "zh-Hant"

	@Option(
		name: [.customShort("f"), .customLong("from")],
		help: "來源語言（BCP-47），預設 en。",
		completion: .custom { _, _, _ in await AppleTranslationEngine().supportedLanguages() }
	)
	var fromLanguage: String = "en"

	@Flag(help: "以 JSON 輸出（含來源 / 目標語言 / 譯文）。")
	var json = false

	@Flag(name: .customLong("list-languages"), help: "列出本機支援的語言代碼後結束，不翻譯。")
	var listLanguages = false

	func run() async throws {
		let engine = AppleTranslationEngine()
		// 可發現性路徑：不讀輸入、不碰語言包，讓「先問有哪些代碼」不必先湊出一次合法翻譯。
		if listLanguages {
			try emitSupportedLanguages(await engine.supportedLanguages())
			return
		}
		let input = try resolveInput()
		guard !input.isEmpty else {
			throw ValidationError("沒有輸入文字。提供位置參數或從 stdin 餵入。")
		}
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
			try emitJSON(payload)
		} else {
			print(translated)
		}
	}

	/// `--list-languages` 的輸出：純文字一行一碼、`--json` 走單鍵 `languages` 物件。
	///
	/// 空清單一律當錯誤，不印空白後 exit 0——「查不到」與「一個都不支援」對呼叫端是同一畫面，
	/// 靜默成功會讓自動化流程把環境問題讀成合法結果。
	private func emitSupportedLanguages(_ codes: [String]) throws {
		guard !codes.isEmpty else {
			throw RuntimeError("取不到支援的語言清單。請確認本機 Apple Translation 可用。")
		}
		if json {
			try emitJSON(["languages": codes])
		} else {
			for code in codes {
				print(code)
			}
		}
	}

	/// JSON 輸出單一出處：鍵排序固定，讓輸出可 diff、可比 golden。
	private func emitJSON(_ payload: [String: Any]) throws {
		let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
		print(String(bytes: data, encoding: .utf8) ?? "")
	}

	/// 位置參數優先；否則讀 stdin（管線 / 重導向）。空輸入回空字串、由呼叫端報錯。
	/// 委派 `InputResolver`：production 行為零改動，耦合點改成可注入參數（見該檔）。
	private func resolveInput() throws -> String {
		try InputResolver.resolve(
			positionalText: text,
			environment: .init(
				isInteractiveTerminal: { isatty(FileHandle.standardInput.fileDescriptor) != 0 },
				readStandardInput: { FileHandle.standardInput.readDataToEndOfFile() }
			)
		)
	}
}
