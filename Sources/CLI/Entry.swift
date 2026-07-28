//
//  KoineCLI
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

/// 執行檔進入點。
///
/// 刻意與命令定義（`KoineCLI`）分家：`.commandLineTool` 產物不輸出可連結符號給測試 bundle，
/// 命令定義只能以原始檔形式一併編進測試 target 才測得到——`@main` 若留在命令型別上，
/// 測試 bundle 會多出一個進入點而編不過。本檔是唯一不進測試 target 的 CLI 檔。
@main
enum KoineEntry {

	static func main() async {
		await KoineCLI.main()
	}
}
