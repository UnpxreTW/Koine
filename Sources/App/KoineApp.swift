//
//  KoineApp
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import SwiftUI

// Host App — Safari Web Extension 的容器 app。
// 主要功能：引導使用者在 Safari 啟用擴充、下載 Apple Translation 語言包。
// 翻譯本體在 Extension target，不在這裡。

@main
struct KoineApp: App {

	var body: some Scene {
		WindowGroup {
			ContentView()
		}
	}
}

struct ContentView: View {

	var body: some View {
		Text("在 Safari 設定中啟用「雅言」擴充功能即可使用。")
			.padding()
	}
}
