// Minimal ICU uchar.h shim —— 提供字符分类的最小实现。

#pragma once

#include "unicode/utypes.h"

// 常规类别掩码（对齐 ICU U_GC_*_MASK）
constexpr uint32_t U_GC_CN_MASK = 0x0001;
constexpr uint32_t U_GC_LU_MASK = 0x0002;
constexpr uint32_t U_GC_LL_MASK = 0x0004;
constexpr uint32_t U_GC_LT_MASK = 0x0008;
constexpr uint32_t U_GC_LM_MASK = 0x0010;
constexpr uint32_t U_GC_LO_MASK = 0x0020;
constexpr uint32_t U_GC_MN_MASK = 0x0040;
constexpr uint32_t U_GC_ME_MASK = 0x0080;
constexpr uint32_t U_GC_MC_MASK = 0x0100;
constexpr uint32_t U_GC_ND_MASK = 0x0200;
constexpr uint32_t U_GC_NL_MASK = 0x0400;
constexpr uint32_t U_GC_NO_MASK = 0x0800;
constexpr uint32_t U_GC_ZS_MASK = 0x1000;
constexpr uint32_t U_GC_ZL_MASK = 0x2000;
constexpr uint32_t U_GC_ZP_MASK = 0x4000;
constexpr uint32_t U_GC_CC_MASK = 0x8000;
constexpr uint32_t U_GC_CF_MASK = 0x10000;
constexpr uint32_t U_GC_CS_MASK = 0x20000;
constexpr uint32_t U_GC_CO_MASK = 0x40000;
constexpr uint32_t U_GC_PD_MASK = 0x80000;
constexpr uint32_t U_GC_PS_MASK = 0x100000;
constexpr uint32_t U_GC_PE_MASK = 0x200000;
constexpr uint32_t U_GC_PC_MASK = 0x400000;
constexpr uint32_t U_GC_PO_MASK = 0x800000;
constexpr uint32_t U_GC_PI_MASK = 0x1000000;
constexpr uint32_t U_GC_PF_MASK = 0x2000000;
constexpr uint32_t U_GC_SM_MASK = 0x4000000;
constexpr uint32_t U_GC_SC_MASK = 0x8000000;
constexpr uint32_t U_GC_SK_MASK = 0x10000000;
constexpr uint32_t U_GC_SO_MASK = 0x20000000;

// 组合掩码
constexpr uint32_t U_GC_Z_MASK = U_GC_ZS_MASK | U_GC_ZL_MASK | U_GC_ZP_MASK;
constexpr uint32_t U_GC_P_MASK = U_GC_PD_MASK | U_GC_PS_MASK | U_GC_PE_MASK | U_GC_PC_MASK | U_GC_PO_MASK |
                                 U_GC_PI_MASK | U_GC_PF_MASK;

// 近似字符分类：ASCII 精确，多字节视为字母
inline uint32_t U_GET_GC_MASK(UChar32 c) {
	if (c < 0) return 0;
	if (c <= 0x7F) {
		unsigned char cc = static_cast<unsigned char>(c);
		if (cc == ' ' || (cc >= 0x09 && cc <= 0x0D)) return U_GC_ZS_MASK;
		if (cc >= '0' && cc <= '9') return U_GC_ND_MASK;
		if (cc >= 'A' && cc <= 'Z') return U_GC_LU_MASK;
		if (cc >= 'a' && cc <= 'z') return U_GC_LL_MASK;
		if (cc < 0x20 || cc == 0x7F) return U_GC_CC_MASK;
		if (cc >= 0x21 && cc <= 0x2F) return U_GC_PO_MASK;
		if (cc >= 0x3A && cc <= 0x40) return U_GC_PO_MASK;
		if (cc >= 0x5B && cc <= 0x60) return U_GC_PO_MASK;
		if (cc >= 0x7B && cc <= 0x7E) return U_GC_PO_MASK;
		return U_GC_SO_MASK;
	}
	return U_GC_LO_MASK; // 多字节（CJK 等）视为字母，近似
}

// 近似判断是否为 Unicode 空白字符
inline bool u_isUWhiteSpace(UChar32 c) {
	if (c < 0) return false;
	if (c <= 0x7F)
		return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0x0B || c == 0x0C;
	// 常见全角空白 / 窄不换行空格等
	return c == 0x00A0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 ||
	       c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}
