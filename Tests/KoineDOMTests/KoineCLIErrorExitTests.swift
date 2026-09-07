//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import ArgumentParser
import Foundation
import Testing

// MARK: - KoineCLIErrorExitTests

/// `koine` 錯誤退場的特徵化：訊息本體、附不附 usage、結束碼三者一次釘住。
///
/// `RuntimeError` 的型別層文件寫著「以 `Error: <description>` 印到 stderr、exit 1，不附 usage
/// （usage 留給 `ValidationError` 的參數類錯誤）」——這是自動化呼叫端據以分流的契約：結束碼決定
/// 重試與否，附不附 usage 決定 stderr 那段該當人看的說明還是機器讀的錯誤行。但既有測試只覆蓋到
/// 解析階段的簡短訊息（`KoineCLIInterfaceTests` 的參數組合 golden），退場那一段無人看守。
///
/// 兩個執行期錯誤刻意**從 `InputResolver.resolve` 真丟出來**、不手工建構：把某個呼叫點的
/// `RuntimeError` 改成 `ValidationError` 這種改動，只有走真實路徑才看得出來（`InputResolverTests`
/// 的 golden 記的是 `\(error)`、只有 description，換型別照樣綠）。
///
/// 取值走 ArgumentParser 對外的三個靜態方法，即 `KoineCLI.main()` 內部實際用來收場的同一組——
/// 自行拼 `"Error: \(error)"` 只會測到測試自己寫的字串。
///
/// 斷言刻意寫成結構層而非字面全文：釘的是「兩類錯誤分屬兩種退場」，文案本身另有 golden
/// 看守，兩者分工後文案改寫不會讓本檔跟著紅。
///
/// 本檔不觸發翻譯：只解析輸入與參數，不呼叫 `run()`，故不依賴語言包與 translationd。
private final class KoineCLIErrorExitTests {

	/// 非 UTF-8 輸入：訊息原樣、不附 usage、走一般失敗碼。
	@Test
	private func `renders input decoding failure without usage`() throws {
		let error: any Error = try resolveFailure(isInteractiveTerminal: false, standardInput: Data([0xFF, 0xFE]))
		#expect(KoineCLI.message(for: error) == "\(error)")
		#expect(KoineCLI.fullMessage(for: error).contains("\(error)"))
		#expect(!containsUsage(KoineCLI.fullMessage(for: error)))
		#expect(KoineCLI.exitCode(for: error) == ExitCode.failure)
	}

	/// 互動終端機下無輸入：附 usage、走參數錯誤碼——與上一條是兩種退場，呼叫端據此分流。
	@Test
	private func `renders missing input with usage`() throws {
		let error: any Error = try resolveFailure(isInteractiveTerminal: true, standardInput: Data())
		#expect(KoineCLI.fullMessage(for: error).contains("\(error)"))
		#expect(containsUsage(KoineCLI.fullMessage(for: error)))
		#expect(KoineCLI.exitCode(for: error) == ExitCode.validationFailure)
		let decodingFailure: any Error = try resolveFailure(
			isInteractiveTerminal: false,
			standardInput: Data([0xFF, 0xFE])
		)
		#expect(KoineCLI.exitCode(for: error) != KoineCLI.exitCode(for: decodingFailure))
	}

	/// 解析失敗與正常收場：前者同參數類退場，後者結束碼為零、不得被當成失敗。
	@Test
	private func `renders parse failures and clean exit`() async throws {
		for arguments in [["--unknown-flag"], ["--to"]] {
			guard let error: any Error = await parseFailure(arguments) else {
				Issue.record("預期 \(arguments.joined(separator: " ")) 解析失敗，實際解析成功")
				continue
			}
			#expect(containsUsage(KoineCLI.fullMessage(for: error)))
			#expect(KoineCLI.exitCode(for: error) == ExitCode.validationFailure)
		}
		#expect(KoineCLI.exitCode(for: CleanExit.message("done")) == ExitCode.success)
	}

	/// 是否附上 usage 段。比對不分大小寫：看守的是「有沒有這一段」，不是它怎麼拼。
	private func containsUsage(_ message: String) -> Bool {
		message.lowercased().contains("usage:")
	}

	/// 以注入的環境跑 `InputResolver.resolve` 並回傳它丟出的錯誤；解析成功即為測試前提不成立。
	private func resolveFailure(isInteractiveTerminal: Bool, standardInput: Data) throws -> any Error {
		do {
			let resolved: String = try InputResolver.resolve(
				positionalText: nil,
				environment: .init(
					isInteractiveTerminal: { isInteractiveTerminal },
					readStandardInput: { standardInput }
				)
			)
			throw PreconditionFailure(resolved: resolved)
		} catch let failure as PreconditionFailure {
			throw failure
		} catch {
			return error
		}
	}

	/// 解析指定參數並回傳丟出的錯誤；解析成功回 `nil` 由呼叫端記為失敗。
	///
	/// - Warning: 走 `asyncParse` 而非 `parse`：`--to` / `--from` 掛的是非同步自訂補全，
	///   同步解析路徑遇到它會直接中止程序（ArgumentParser 的硬性檢查）。
	private func parseFailure(_ arguments: [String]) async -> (any Error)? {
		do {
			_ = try await KoineCLI.asyncParse(arguments)
			return nil
		} catch {
			return error
		}
	}
}

// MARK: - PreconditionFailure

/// 預期會丟錯的輸入卻解析成功——測試前提不成立，直接讓該條測試失敗。
private struct PreconditionFailure: Error {

	/// 實際解析出來的字串，附進失敗訊息供辨識。
	fileprivate let resolved: String
}

extension PreconditionFailure: CustomStringConvertible {

	fileprivate var description: String {
		"預期 InputResolver.resolve 丟出錯誤，實際回 \(resolved)"
	}
}
