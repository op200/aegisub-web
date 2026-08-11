// Minimal ICU shim for the Aegisub WASM core build.
// 提供 Aegisub/libaegisub 用到的 ICU C API 最小子集 + 全局 UBRK_* 常量。

#pragma once

#include <cstdint>
#include <string>

using UErrorCode = int32_t;
using UChar32 = int32_t;

enum : int32_t {
	U_ZERO_ERROR = 0,
	U_ILLEGAL_ARGUMENT_ERROR = 1,
	U_INDEX_OUTOFBOUNDS_ERROR = 3,
	U_INTERNAL_PROGRAM_ERROR = 5,
	U_BUFFER_OVERFLOW_ERROR = 15,
};

inline bool U_SUCCESS(UErrorCode code) { return code <= U_ZERO_ERROR; }
inline bool U_FAILURE(UErrorCode code) { return code > U_ZERO_ERROR; }

inline const char* u_errorName(UErrorCode) { return "ICU shim error"; }

// ---- UBreakIterator 全局常量（原定义于 ubrk.h，C API 是全局的）----
constexpr int32_t UBRK_DONE = -1;

// UWordBreak 规则状态（对齐真实 ICU）
constexpr int32_t UBRK_WORD_NONE = 0;
constexpr int32_t UBRK_WORD_NUMBER = 100;
constexpr int32_t UBRK_WORD_LETTER = 200;
constexpr int32_t UBRK_WORD_KANA = 300;
constexpr int32_t UBRK_WORD_IDEO = 400;
constexpr int32_t UBRK_WORD_IDEO_LIMIT = 500;
