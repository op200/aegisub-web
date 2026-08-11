// Minimal ICU utf8.h shim —— 提供 U8_NEXT 宏（按 UTF-8 解码下一个码点）。

#pragma once

#include "unicode/utypes.h"

// U8_NEXT(s, i, length, c)：从 s[i] 开始解码一个 UTF-8 码点存入 c，并推进 i。
#define U8_NEXT(s, i, length, c)                                                                    \
	{                                                                                                \
		(c) = static_cast<unsigned char>((s)[i]);                                                    \
		if ((c) >= 0x80) {                                                                           \
			if ((c) < 0xE0) {                                                                        \
				(c) = ((c)&0x1F) << 6 | (static_cast<unsigned char>((s)[(i) + 1]) & 0x3F);           \
				(i) += 2;                                                                            \
			} else if ((c) < 0xF0) {                                                                 \
				(c) = ((c)&0x0F) << 12 | (static_cast<unsigned char>((s)[(i) + 1]) & 0x3F) << 6 |    \
				      (static_cast<unsigned char>((s)[(i) + 2]) & 0x3F);                            \
				(i) += 3;                                                                            \
			} else {                                                                                 \
				(c) = ((c)&0x07) << 18 | (static_cast<unsigned char>((s)[(i) + 1]) & 0x3F) << 12 |   \
				      (static_cast<unsigned char>((s)[(i) + 2]) & 0x3F) << 6 |                       \
				      (static_cast<unsigned char>((s)[(i) + 3]) & 0x3F);                            \
				(i) += 4;                                                                            \
			}                                                                                        \
		} else {                                                                                     \
			++(i);                                                                                   \
		}                                                                                            \
	}
