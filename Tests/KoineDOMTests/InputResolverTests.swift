//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import CharacterizationSupport
import Foundation
import Testing

// MARK: - ResolveCase

/// 單一 `InputResolver.resolve` 案例的裁定結果，收進批次 golden。
private struct ResolveCase: Encodable {
	let scenario: String
	let outcome: String
}

// MARK: - InputResolverTests

/// `InputResolver.resolve` 六案 golden：位置參數／stdin 正常／stdin 空／stdin 非 UTF-8／互動 TTY 無參數。
private final class InputResolverTests {

	/// 六案一次 golden：成功案記 `success: <value>`、失敗案記 `failure: <error>`。
	@Test
	private func `resolves across input scenarios`() throws {
		var cases: [ResolveCase] = []

		func run(_ scenario: String, positionalText: String?, environment: InputResolver.Environment) {
			let outcome: String
			do {
				let result = try InputResolver.resolve(positionalText: positionalText, environment: environment)
				outcome = "success: \(result)"
			} catch {
				outcome = "failure: \(error)"
			}
			cases.append(ResolveCase(scenario: scenario, outcome: outcome))
		}

		run(
			"positional text",
			positionalText: "Hello, world",
			environment: .init(isInteractiveTerminal: { false }, readStandardInput: { Data() })
		)
		run(
			"positional text with surrounding whitespace",
			positionalText: "  Hello  \n",
			environment: .init(isInteractiveTerminal: { false }, readStandardInput: { Data() })
		)
		run(
			"non-interactive stdin valid UTF-8",
			positionalText: nil,
			environment: .init(isInteractiveTerminal: { false }, readStandardInput: { Data("Bonjour\n".utf8) })
		)
		run(
			"non-interactive stdin empty data",
			positionalText: nil,
			environment: .init(isInteractiveTerminal: { false }, readStandardInput: { Data() })
		)
		run(
			"non-interactive stdin invalid UTF-8",
			positionalText: nil,
			environment: .init(isInteractiveTerminal: { false }, readStandardInput: { Data([0xFF, 0xFE]) })
		)
		run(
			"interactive terminal without positional text",
			positionalText: nil,
			environment: .init(isInteractiveTerminal: { true }, readStandardInput: { Data() })
		)

		try expectGolden(of: cases, as: .json)
	}
}
