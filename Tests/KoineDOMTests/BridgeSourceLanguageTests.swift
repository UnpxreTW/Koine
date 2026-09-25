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

// MARK: - RecordingEngine

/// 記錄自己被怎麼呼叫的引擎：`respond(to:)` 決定的來源語只有從這裡看得到。
private actor RecordingEngine: TranslationEngine {

	/// `translate` 收到的來源語標籤，依呼叫順序。
	internal private(set) var translateSourceTags: [String] = []

	/// `status` 收到的來源語標籤，依呼叫順序。
	internal private(set) var statusSourceTags: [String] = []

	/// 恆回已安裝，讓預查讓開、路走到 `translate`。
	internal func status(from source: Locale.Language, to target: Locale.Language) async -> LanguagePairStatus {
		statusSourceTags.append(source.maximalIdentifier)
		return .installed
	}

	/// 記錄來源語並回固定譯文。
	internal func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		translateSourceTags.append(source.maximalIdentifier)
		return "譯:\(text)"
	}
}

// MARK: - BridgeSourceLanguageTests

/// 來源語解析：偵測結果為主、請求帶來的標籤為回退，已達目標語者不送進引擎。
///
/// 進引擎的來源語一律只比**語言與書寫系統前綴**、不比完整的 maximal identifier：補齊 likely
/// subtags 時填進來的地區子標籤由 ICU 的資料版本決定，釘死它等於讓測試隨系統版本閃紅。前綴
/// 已足以分辨本檔要分辨的事（偵測值 vs 請求標籤 vs 預設值）。
private final class BridgeSourceLanguageTests {

	/// 偵測得出結果時，進引擎的是偵測值、不是請求帶來的標籤。
	///
	/// 這條釘住整個改動的目的：頁面標 `zh-TW`、內嵌區塊實際是簡體，靠標籤永遠判不出來。
	@Test
	private func `detected language overrides the requested tag`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector(result: "zh-Hans"))
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "这是简体段落。", "from": "zh-TW", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: "譯:这是简体段落。"))
		let tags: [String] = await engine.translateSourceTags
		#expect(tags.count == 1, "實得 \(tags)")
		#expect(tags.first?.hasPrefix("zh-Hans") == true, "進引擎的來源語應為偵測值，實得 \(tags)")
	}

	/// 偵測不出來時回退到請求帶來的標籤（＝最近帶 `lang` 的祖先，再無則頁面語言）。
	@Test
	private func `undetected language falls back to the requested tag`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "短", "from": "zh-CN", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: "譯:短"))
		let tags: [String] = await engine.translateSourceTags
		#expect(tags.count == 1, "實得 \(tags)")
		#expect(tags.first?.hasPrefix("zh-Hans") == true, "應回退到請求標籤，實得 \(tags)")
	}

	/// 來源語已滿足目標語：回空譯文（＝譯文＝原文、不顯示），引擎一次都不被呼叫。
	///
	/// 沒有這條短路，繁中頁上的每一段都會拿 `zh-Hant → zh-Hant` 去問語言包，回來的
	/// 「不支援」會被記成那一段翻譯失敗。
	@Test
	private func `already target language short circuits without touching the engine`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector(result: "zh-Hant"))
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "這是繁體段落。", "from": "zh-TW", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: ""))
		let translated: [String] = await engine.translateSourceTags
		let queried: [String] = await engine.statusSourceTags
		#expect(translated.isEmpty, "已達標的段不該進引擎，實得 \(translated)")
		#expect(queried.isEmpty, "連預查都不該發出，實得 \(queried)")
	}

	/// 地區形與書寫系統形視為同一件事：`zh-TW` 對 `zh-Hant` 算已達標。
	///
	/// 逐字比字串會讓 `<html lang="zh-TW">`（頁面上最常見的寫法）永遠判成「要翻」。
	@Test
	private func `region form counts as the same script as the target`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "這是繁體段落。", "from": "zh-TW", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: ""))
		let translated: [String] = await engine.translateSourceTags
		#expect(translated.isEmpty)
	}

	/// 小寫形照樣認得——瀏覽器端送上來的標籤一律小寫（`lang` 屬性讀進來就 `toLowerCase`）。
	///
	/// 其餘用例都用 canonical 大小寫，唯獨線上真正流通的是這一形；沒有這條，整個
	/// 「繁中頁不重複翻譯」就押在一個沒人驗過的正規化上。
	@Test
	private func `lowercase wire form is recognised`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "這是繁體段落。", "from": "zh-tw", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: ""))
		let translated: [String] = await engine.translateSourceTags
		#expect(translated.isEmpty, "小寫的 zh-tw 應與 zh-Hant 視為同一件事，實得 \(translated)")
	}

	/// 標籤說已達標、內容卻沒有漢字：不短路，而且那個標籤也不拿去當引擎的來源語。
	///
	/// 繁體頁面上的短英文（`Home`／`Menu`／`alt="Search"`）繼承到的標籤是頁面的語言，而偵測器
	/// 對這種長度的字串常判不出來。沒有這道守門，它們會被判成已達標而靜默不譯；守門只擋短路
	/// 而不換掉來源語的話，引擎會收到 `zh-Hant → zh-Hant` 這種自我翻譯——那不是修好，是換一
	/// 種壞法。故本條同時斷言進引擎的來源語已換成線上契約的預設值。
	@Test
	private func `distrusted tag is not used as the engine source`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "Download", "from": "zh-TW", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: "譯:Download"))
		let tags: [String] = await engine.translateSourceTags
		// 只比語言碼前綴、不釘 ICU 補出來的地區子標籤（那是實作細節、跨版本會動）。
		#expect(tags.count == 1, "實得 \(tags)")
		#expect(tags.first?.hasPrefix("en") == true, "來源語應換成預設值，實得 \(tags)")
	}

	/// 內容守門只在「標籤是用猜的」那條路上套：偵測判得出來就採信偵測、不回頭問內容。
	@Test
	private func `detected language is trusted without the content guard`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector(result: "zh-Hant"))
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "Download", "from": "en", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: ""))
		let translated: [String] = await engine.translateSourceTags
		#expect(translated.isEmpty, "實得 \(translated)")
	}

	/// 標籤沒有自稱已達目標語時不套內容守門：呼叫端明確要的語言對照原樣送進引擎。
	///
	/// 這條釘住守門的射程。把它擴大成「任何標籤都要內容相符」會讓 `zh-Hant → ja` 這種正當
	/// 請求的來源語被換成預設值，錯誤訊息也會印出呼叫端從未送過的標籤。
	@Test
	private func `guard does not apply when the tag claims nothing`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "Hello", "from": "zh-TW", "to": "ja",
		])
		#expect(out == .translated(identifier: "k1-0", text: "譯:Hello"))
		let tags: [String] = await engine.translateSourceTags
		#expect(tags.count == 1, "實得 \(tags)")
		#expect(tags.first?.hasPrefix("zh") == true, "來源語應原樣沿用呼叫端的標籤，實得 \(tags)")
	}

	/// 目標語不是中文時，內容守門不表態：標籤自稱已達標就短路。
	///
	/// 守門只對漢字書寫系統有意見（問題出在那一側），其餘一律放行。這條路會讓段落完全不譯，
	/// 沒有斷言的話把守門改成一律否決也不會有人發現。
	@Test
	private func `guard stays out of non chinese targets`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "Hello", "from": "ja", "to": "ja",
		])
		#expect(out == .translated(identifier: "k1-0", text: ""))
		let translated: [String] = await engine.translateSourceTags
		#expect(translated.isEmpty, "實得 \(translated)")
	}

	/// 書寫系統不同即不算已達標：簡中段照樣送翻，這正是簡→繁就地換字所依賴的判準。
	@Test
	private func `different script is not already target`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector())
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "这是简体段落。", "from": "zh-CN", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: "譯:这是简体段落。"))
	}

	/// 語言不同（日文對繁中）照樣送翻——短路只認「同語言且同書寫系統」。
	@Test
	private func `different language is not already target`() async {
		let engine: RecordingEngine = .init()
		let translator: BridgeTranslator = .init(engine: engine, detector: FixedLanguageDetector(result: "ja"))
		let out: BridgeResponse = await translator.handle([
			"id": "k1-0", "source": "日本語の段落です。", "from": "zh-TW", "to": "zh-Hant",
		])
		#expect(out == .translated(identifier: "k1-0", text: "譯:日本語の段落です。"))
		let tags: [String] = await engine.translateSourceTags
		#expect(tags.count == 1, "實得 \(tags)")
		#expect(tags.first?.hasPrefix("ja") == true, "實得 \(tags)")
	}
}
