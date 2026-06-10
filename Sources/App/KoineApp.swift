//
//  KoineApp
//
//  SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
//  SPDX-License-Identifier: MPL-2.0

import SwiftUI

// Host App — Safari Web Extension 的容器 app。
// 主要功能（v1）：引導使用者在 Safari 啟用擴充、下載 Apple Translation 語言包。
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
		VStack(spacing: 16) {
			Text("雅言")
				.font(.largeTitle.bold())
			Text("在 Safari 設定中啟用「雅言」擴充功能即可使用。")
				.multilineTextAlignment(.center)
				.foregroundStyle(.secondary)
				.padding(.horizontal)
		}
		.padding()
		.frame(minWidth: 360, minHeight: 200)
	}
}
