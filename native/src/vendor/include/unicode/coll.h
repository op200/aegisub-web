// Minimal ICU coll.h shim —— 提供 Collator 的最小实现（PRIMARY 强度 ≈ 忽略大小写）。

#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include "unicode/utypes.h"

namespace icu {

class Collator {
public:
	enum CollationStrength { PRIMARY = 0, SECONDARY = 1, TERTIARY = 2 };

	static Collator* createInstance(UErrorCode&) { return new Collator; }

	void setStrength(CollationStrength strength) { strength_ = strength; }

	// compareUTF8：比较两个 UTF-8 字符串，返回 <0 / 0 / >0
	int compareUTF8(std::string_view a, std::string_view b, UErrorCode&) {
		if (strength_ == PRIMARY) return compare_casefold(a, b);
		return a.compare(b);
	}

private:
	static unsigned char fold_byte(unsigned char c) {
		if (c >= 'A' && c <= 'Z') return static_cast<unsigned char>(c + 32);
		return c;
	}
	static int compare_casefold(std::string_view a, std::string_view b) {
		size_t n = a.size() < b.size() ? a.size() : b.size();
		for (size_t i = 0; i < n; ++i) {
			unsigned char ca = fold_byte(static_cast<unsigned char>(a[i]));
			unsigned char cb = fold_byte(static_cast<unsigned char>(b[i]));
			if (ca != cb) return ca < cb ? -1 : 1;
		}
		if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
		return 0;
	}

	CollationStrength strength_ = TERTIARY;
};

} // namespace icu
