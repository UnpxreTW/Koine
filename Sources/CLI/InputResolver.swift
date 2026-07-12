//
//  InputResolver
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import ArgumentParser
import Foundation

/// 位置參數 vs stdin 的輸入解析，抽離 `KoineCLI` 的 `self` 與全域 I/O 耦合，供測試注入。
///
/// production 路徑（`isatty` + `FileHandle.standardInput`）與測試路徑（固定值 / 固定 `Data`）
/// 透過 `Environment` 的注入點分流，行為零改動。
enum InputResolver {

	/// 呼叫端注入的環境探針；production 路徑仍是 isatty + FileHandle.standardInput，
	/// 測試路徑注入固定值/固定 Data。
	struct Environment {
		var isInteractiveTerminal: () -> Bool
		var readStandardInput: () -> Data
	}

	/// 位置參數優先；否則讀 stdin（管線 / 重導向）。空輸入回空字串、由呼叫端報錯。
	static func resolve(positionalText: String?, environment: Environment) throws -> String {
		if let positionalText {
			return positionalText.trimmingCharacters(in: .whitespacesAndNewlines)
		}
		// 互動 TTY 且無位置參數：不會有管線輸入，直接報錯——
		// 否則 readStandardInput() 會無提示阻塞到 Ctrl-D、看起來像當機。
		guard !environment.isInteractiveTerminal() else {
			throw ValidationError("沒有輸入文字。提供位置參數或從 stdin 餵入。")
		}
		let data = environment.readStandardInput()
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
