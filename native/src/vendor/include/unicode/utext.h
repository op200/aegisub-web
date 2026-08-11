// Minimal ICU UText shim — 只保存 UTF-8 字节。

#pragma once

#include <string>

#include "unicode/utypes.h"

struct UText {
	std::string bytes;
};

inline UText* utext_openUTF8(UText*, const char* data, int32_t size, UErrorCode*) {
	auto* ut = new UText;
	if (data && size >= 0) ut->bytes.assign(data, static_cast<size_t>(size));
	return ut;
}

inline void utext_close(UText* ut) { delete ut; }
