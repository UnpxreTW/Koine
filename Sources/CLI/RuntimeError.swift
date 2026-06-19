//
//  KoineCLI
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

/// 執行期錯誤：以 `Error: <description>` 印到 stderr、exit 1，不附 usage
/// （usage 留給 `ValidationError` 的參數類錯誤）。
struct RuntimeError: Error, CustomStringConvertible {

	let description: String

	init(_ description: String) {
		self.description = description
	}
}
