//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation
import NaturalLanguage

/// 走 Apple `NaturalLanguage` 的語言偵測器。
///
/// 只採信最高機率的那個假設、且其機率須達門檻；達不到即回 `nil`，把決定權交還給標記語言。
/// 不設最小長度門檻——短字串的低信心本來就會被門檻擋下，再加一道長度閘只會讓「短但明確」
/// 的字串（按鈕文案、`alt` 文字）白白失去偵測。
public struct LanguageRecognizerDetector: LanguageDetecting {

	/// 採信偵測結果所需的最低機率。
	///
	/// 取 0.72：低於此值時 `NLLanguageRecognizer` 對中日韓同形漢字的區分已不穩定，而誤判的
	/// 代價是不對稱的——把繁體誤判成簡體會觸發就地換字、原文從頁面消失。
	public static let defaultConfidenceThreshold: Double = 0.72

	/// 本實例採用的信心門檻。
	private let confidenceThreshold: Double

	/// 以信心門檻建構（預設 `defaultConfidenceThreshold`）。
	public init(confidenceThreshold: Double = Self.defaultConfidenceThreshold) {
		self.confidenceThreshold = confidenceThreshold
	}

	/// 取最高機率假設，達門檻才回其 BCP-47 標籤。
	///
	/// 取 `languageHypotheses` 而非 `dominantLanguage`：後者只回語言、不回機率，門檻就無從套用。
	public func detect(_ text: String) -> String? {
		let recognizer: NLLanguageRecognizer = .init()
		recognizer.processString(text)
		guard let best: (key: NLLanguage, value: Double) =
			recognizer.languageHypotheses(withMaximum: 1).max(by: { $0.value < $1.value })
		else { return nil }
		guard best.value >= confidenceThreshold else { return nil }
		return best.key.rawValue
	}
}
