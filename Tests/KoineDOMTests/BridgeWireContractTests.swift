//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation
import Koine
import Testing

// MARK: - BridgeWireContractTests

/// §9.4 Bridge JSON 的線上形狀：`BridgeRequest.parse(_:)` 讀進來的鍵、`BridgeResponse.payload`
/// 寫出去的鍵。
///
/// typed 型別是內部形狀、可以重構；**這一層是對 JS 端的承諾、不可**。故本檔的期望值一律寫
/// 字面常數，不從 `BridgeRequest` / `BridgeResponse` 推導——推導式期望值會跟著被改壞的實作
/// 一起漂、照樣全綠。
private final class BridgeWireContractTests {

	/// `.translated` → `{ id, text }`，鍵名與鍵數皆釘死（多一個鍵也算破壞契約）。
	@Test
	private func `translated payload carries ID and text`() {
		let payload: [String: Any] = BridgeResponse.translated(identifier: "k1-0", text: "譯文").payload
		#expect(payload as NSDictionary == ["id": "k1-0", "text": "譯文"] as NSDictionary)
	}

	/// 空譯文是有效終態（譯文＝原文、不顯示）：`text` 鍵仍在、值為空字串。
	/// 少了這條，把空字串當「沒有譯文」而略去該鍵的寫法會讓 JS 端改判 `no-text` 失敗。
	@Test
	private func `empty translation keeps the text key`() {
		let payload: [String: Any] = BridgeResponse.translated(identifier: "k1-0", text: "").payload
		#expect(payload as NSDictionary == ["id": "k1-0", "text": ""] as NSDictionary)
	}

	/// `.failed` → `{ id, error }`：帶 id，供 JS 端把失敗對回那一段。
	@Test
	private func `failed payload carries ID and error`() {
		let payload: [String: Any] = BridgeResponse.failed(identifier: "k1-0", message: "壞了").payload
		#expect(payload as NSDictionary == ["id": "k1-0", "error": "壞了"] as NSDictionary)
	}

	/// `.unidentified` → `{ error }`：**不帶 id**（沒有任何段對得回來）。
	@Test
	private func `unidentified payload omits the ID`() {
		let payload: [String: Any] = BridgeResponse.unidentified(message: "missing id").payload
		#expect(payload as NSDictionary == ["error": "missing id"] as NSDictionary)
	}

	/// `from` / `to` 缺席時補上預設值 en → zh-Hant（content script 只在頁面帶 `lang` 時送 `from`）。
	@Test
	private func `parse fills in the default language tags`() {
		let parsed: BridgeRequest.Parsed = BridgeRequest.parse(["id": "k1-0", "source": "Hello"])
		guard case .request(let request) = parsed else {
			Issue.record("欄位齊備應解析成功，實得 \(parsed)")
			return
		}
		#expect(request.identifier == "k1-0")
		#expect(request.source == "Hello")
		#expect(request.sourceLanguage == "en")
		#expect(request.targetLanguage == "zh-Hant")
	}

	/// 有 `from` / `to` 就原樣採用，不被預設值蓋掉。
	@Test
	private func `parse takes the provided language tags`() {
		let parsed: BridgeRequest.Parsed = BridgeRequest.parse([
			"id": "k1-0", "source": "Hello", "from": "ja", "to": "zh-Hans"
		])
		guard case .request(let request) = parsed else {
			Issue.record("欄位齊備應解析成功，實得 \(parsed)")
			return
		}
		#expect(request.sourceLanguage == "ja")
		#expect(request.targetLanguage == "zh-Hans")
	}

	/// JS 端送的 `type` 判別欄在 `parse(_:)` 不構成分支——多帶這個鍵解出來的請求完全相同。
	///
	/// 涵蓋面僅止於 `parse`：`BridgeRequest` 根本沒有 `type` 欄位，故本條偵測得到的只有
	/// 「`parse` 自己開始看 `type`」這一種變化。日後若把 dispatch 加在 `handle` 或 handler
	/// 層，這條照樣全綠——那一層要另立測試。
	@Test
	private func `parse ignores the type discriminator`() {
		let withType: BridgeRequest.Parsed = BridgeRequest.parse([
			"type": "translate", "id": "k1-0", "source": "Hello"
		])
		let withoutType: BridgeRequest.Parsed = BridgeRequest.parse(["id": "k1-0", "source": "Hello"])
		// 先釘住兩側都真的解析成功，再比相等：只比相等的話，`parse` 若退化成無條件回同一個
		// `.malformed`，兩側會一起退化、這條照樣全綠。
		guard case .request(let request) = withType else {
			Issue.record("帶 type 欄的訊息仍應解析成功，實得 \(withType)")
			return
		}
		#expect(request.identifier == "k1-0")
		#expect(request.source == "Hello")
		#expect(withType == withoutType)
	}

	/// 缺 `id` → `.unidentified`，且線上形狀不帶 id。
	@Test
	private func `parse without ID yields an unidentified response`() {
		let parsed: BridgeRequest.Parsed = BridgeRequest.parse(["source": "Hello"])
		#expect(parsed == .malformed(.unidentified(message: "missing id")))
	}

	/// 缺 `source` → `.failed`，且線上形狀帶著原本那個 id。
	@Test
	private func `parse without source keeps the ID`() {
		let parsed: BridgeRequest.Parsed = BridgeRequest.parse(["id": "k1-0"])
		#expect(parsed == .malformed(.failed(identifier: "k1-0", message: "missing source")))
	}

	/// 鍵在但型別不符（`id` 是數字、`source` 是陣列）視同缺席——邊界收的是任意 property list，
	/// 光看「鍵存不存在」不足以判定可用。
	@Test
	private func `parse treats mistyped fields as missing`() {
		#expect(BridgeRequest.parse(["id": 42, "source": "Hello"])
			== .malformed(.unidentified(message: "missing id")))
		#expect(BridgeRequest.parse(["id": "k1-0", "source": ["Hello"]])
			== .malformed(.failed(identifier: "k1-0", message: "missing source")))
	}

	/// 語言標籤型別不符時退回預設值，不讓錯型別的值一路流進 `Locale.Language`。
	@Test
	private func `parse falls back when language tags are mistyped`() {
		let parsed: BridgeRequest.Parsed = BridgeRequest.parse([
			"id": "k1-0", "source": "Hello", "from": 1, "to": 2
		])
		guard case .request(let request) = parsed else {
			Issue.record("必要欄位齊備應解析成功，實得 \(parsed)")
			return
		}
		#expect(request.sourceLanguage == "en")
		#expect(request.targetLanguage == "zh-Hant")
	}
}
