// Minimal ICU BreakIterator shim.
// 用 UTF-8 码点迭代近似词/字符边界，供 Aegisub WASM 核心编译使用。
// 语义对齐 icu::BreakIterator：
//   - next() 返回下一个边界的字节偏移，越界返回 UBRK_DONE
//   - current() 返回当前边界偏移
//   - getRuleStatusVec 返回 [状态, UBRK_WORD_NONE]

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "unicode/locid.h"
#include "unicode/utext.h"
#include "unicode/utypes.h"

namespace icu {

enum UBreakIteratorType {
	UBRK_CHARACTER = 0,
	UBRK_WORD = 1,
	UBRK_LINE = 2,
};

class BreakIterator {
	std::string text_;
	std::vector<int32_t> boundaries_;
	int32_t status_ = UBRK_WORD_NONE;
	size_t pos_ = 0;
	bool is_word_ = false;

	// 解码 text_[offset] 处的码点，返回码点宽度（字节数）
	static int32_t cp_width(char const* s, size_t len) {
		unsigned char c = static_cast<unsigned char>(*s);
		if (c < 0x80) return 1;
		if ((c & 0xE0) == 0xC0) return 2;
		if ((c & 0xF0) == 0xE0) return 3;
		if ((c & 0xF8) == 0xF0) return 4;
		return 1;
	}

	// 近似判断该码点是否属于"词"（字母/数字/下划线/连字线）
	static bool is_word_cp(char const* s, int32_t width) {
		if (width == 1) {
			unsigned char c = static_cast<unsigned char>(*s);
			return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' ||
			       c == '-' || c == '\'' || c == 0xC2; // 0xC2 覆盖 © 等两字节符号的开头（近似）
		}
		// 多字节字符（CJK 等）视为词
		return true;
	}

	void compute_boundaries(bool character) {
		boundaries_.clear();
		boundaries_.push_back(0);
		size_t offset = 0;
		bool prev_word = false;
		while (offset < text_.size()) {
			int32_t w = cp_width(text_.data() + offset, text_.size() - offset);
			bool cur_word = character ? true : is_word_cp(text_.data() + offset, w);
			if (character || cur_word != prev_word) {
				boundaries_.push_back(static_cast<int32_t>(offset));
				if (!character) status_ = cur_word ? UBRK_WORD_LETTER : UBRK_WORD_NONE;
			}
			prev_word = cur_word;
			offset += static_cast<size_t>(w);
		}
		boundaries_.push_back(static_cast<int32_t>(text_.size()));
		if (character) boundaries_.erase(boundaries_.end() - 1, boundaries_.end()); // 字符模式不含尾部
		if (!character && boundaries_.back() != static_cast<int32_t>(text_.size()))
			boundaries_.push_back(static_cast<int32_t>(text_.size()));
	}

public:
	explicit BreakIterator(int32_t type = UBRK_WORD) {
		(void)type;
	}

	static BreakIterator* createWordInstance(const Locale&, UErrorCode&) { return new BreakIterator(UBRK_WORD); }
	static BreakIterator* createCharacterInstance(const Locale&, UErrorCode&) {
		return new BreakIterator(UBRK_CHARACTER);
	}
	static BreakIterator* createLineInstance(const Locale&, UErrorCode&) { return new BreakIterator(UBRK_WORD); }

	void setText(UText* ut, UErrorCode&) {
		text_ = ut ? ut->bytes : std::string();
		compute_boundaries(false);
		pos_ = 0;
		status_ = UBRK_WORD_NONE;
	}
	void setText(const std::string& text) {
		text_ = text;
		compute_boundaries(false);
		pos_ = 0;
		status_ = UBRK_WORD_NONE;
	}

	int32_t first() {
		pos_ = 0;
		status_ = UBRK_WORD_NONE;
		return 0;
	}

	int32_t next() {
		if (pos_ + 1 >= boundaries_.size()) return UBRK_DONE;
		++pos_;
		int32_t r = boundaries_[pos_];
		status_ = (pos_ > 0 && pos_ < boundaries_.size() - 1) ? UBRK_WORD_LETTER : UBRK_WORD_NONE;
		return r;
	}

	int32_t current() const { return pos_ < boundaries_.size() ? boundaries_[pos_] : UBRK_DONE; }

	int32_t following(int32_t offset) {
		for (size_t i = 0; i < boundaries_.size(); ++i)
			if (boundaries_[i] > offset) {
				pos_ = i;
				return boundaries_[i];
			}
		return UBRK_DONE;
	}

	bool isBoundary(int32_t offset) {
		for (auto b : boundaries_)
			if (b == offset) return true;
		return false;
	}

	int32_t getRuleStatus() const { return status_; }

	int32_t getRuleStatusVec(int32_t* fillInVec, int32_t capacity, UErrorCode& status) {
		if (capacity < 1) {
			status = U_BUFFER_OVERFLOW_ERROR;
			return 1;
		}
		fillInVec[0] = status_;
		return 1;
	}
};

} // namespace icu
