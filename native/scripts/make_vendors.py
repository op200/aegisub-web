#!/usr/bin/env python3
"""生成 native/src/vendor/ 下的精简副本（去掉 wx/UI 依赖）。

把 Aegisub 中 wx 强耦合的核心文件复制到 vendor/ 并做最小替换，使 WASM 核心可编译。
幂等：重复运行会重新生成。用法: python native/scripts/make_vendors.py
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VENDOR_DIR = os.path.join(ROOT, "native", "src", "vendor")
os.makedirs(VENDOR_DIR, exist_ok=True)


def read(rel: str) -> str:
    with open(os.path.join(ROOT, rel), "r", encoding="utf-8") as f:
        return f.read()


def write(name: str, content: str) -> None:
    with open(os.path.join(VENDOR_DIR, name), "w", encoding="utf-8", newline="") as f:
        f.write(content)
    print("vendored:", name)


def replace_all(content: str, old: str, new: str) -> str:
    """同时处理 LF 与 CRLF 结尾的精确替换。"""
    if old in content:
        return content.replace(old, new)
    alt = old.replace("\n", "\r\n")
    if alt in content:
        return content.replace(alt, new)
    raise RuntimeError("pattern not found: %r" % old[:60])


MID_TEMPLATE = """#include "ass_dialogue.h"
#include "subtitle_format.h"

// vendored: 去掉 utils.h（wx 依赖），内联需要的 mid()/float_to_string()
template<typename T> inline T mid(T a, T b, T c) {
	return a > b ? a : (b > c ? c : b);
}

inline std::string float_to_string(double val, int precision = 3) {
	char buf[64];
	snprintf(buf, sizeof(buf), "%.*f", precision, val);
	std::string s(buf);
	size_t pos = s.find_last_not_of("0");
	if (pos != s.find(".")) ++pos;
	s.erase(begin(s) + pos, end(s));
	return s;
}
"""


# ---------- ass_dialogue.cpp ----------
c = read("Aegisub/src/ass_dialogue.cpp")
c = replace_all(
    c,
    '#include "ass_dialogue.h"\n#include "subtitle_format.h"\n#include "utils.h"',
    MID_TEMPLATE,
)
write("ass_dialogue.cpp", c)


# ---------- ass_style.cpp ----------
c = read("Aegisub/src/ass_style.cpp")
c = replace_all(
    c,
    '#include "subtitle_format.h"\n#include "utils.h"',
    MID_TEMPLATE,
)
c = re.sub(r'(?m)^#include <wx/intl\.h>\r?\n', "", c)
# GetEncodings 置空（UI 专用）
pattern = re.compile(
    r"(?s)void AssStyle::GetEncodings\(wxArrayString &encodingStrings\) \{.*?\r?\n\}",
    re.DOTALL,
)
c = pattern.sub(
    """void AssStyle::GetEncodings(wxArrayString &encodingStrings) {
#ifndef AEGISUB_CORE_WASM
	(void)encodingStrings; // vendored: UI 专用，Web 版不实现
#endif
}
""",
    c,
)
write("ass_style.cpp", c)


# ---------- ass_file.cpp ----------
c = read("Aegisub/src/ass_file.cpp")
for inc in ("async_video_provider", "options", "project", "ass_style_storage"):
    c = re.sub(r'(?m)^#include "%s\.h"\r?\n' % inc, "", c)
c = re.sub(r'(?m)^#include "include/aegisub/context\.h"\r?\n', "", c)

# LoadDefault: OPT_GET → 硬编码
pattern = re.compile(
    r'(?s)if \(!OPT_GET\("Subtitle/Default Resolution/Auto"\)->GetBool\(\)\) \{.*?\r?\n\s*\}',
    re.DOTALL,
)
c = pattern.sub(
    'Info.emplace_back("PlayResX", "1920"); // vendored: 硬编码默认分辨率\n'
    '\tInfo.emplace_back("PlayResY", "1080");\n',
    c,
)

# 目录样式块置空
pattern = re.compile(r"(?s)\t// Add/replace any catalog styles requested.*?\r?\n\t\}", re.DOTALL)
c = pattern.sub("\t// vendored: 目录样式在 Web 版暂不支持\n", c)

# GetEffectiveLayoutResolution: WASM 版退回脚本分辨率
pattern = re.compile(
    r"(?s)void AssFile::GetEffectiveLayoutResolution\(agi::Context \*c, int &lw, int &lh\) const \{.*?\r?\n\}",
    re.DOTALL,
)
c = pattern.sub(
    """void AssFile::GetEffectiveLayoutResolution(agi::Context *c, int &lw, int &lh) const {
#ifdef AEGISUB_CORE_WASM
	(void)c;
	GetResolution(lw, lh); // vendored: 无视频提供者，退回脚本分辨率
#else
	GetLayoutResolution(lw, lh);
	if (lw == 0 || lh == 0) {
		if (c->project->VideoProvider()) {
			lw = c->project->VideoProvider()->GetWidth();
			lh = c->project->VideoProvider()->GetHeight();
		} else {
			GetResolution(lw, lh);
		}
	}
#endif
}
""",
    c,
)

# Commit: WASM 版 stub
pattern = re.compile(
    r"(?s)int AssFile::Commit\(wxString const& desc, int type, int amend_id, AssDialogue \*single_line\) \{.*?\r?\n\}",
    re.DOTALL,
)
c = pattern.sub(
    """int AssFile::Commit(wxString const& desc, int type, int amend_id, AssDialogue *single_line) {
#ifdef AEGISUB_CORE_WASM
	// vendored: Web 版撤销由 ABI 层用整文件快照实现
	(void)desc; (void)type; (void)single_line;
	return amend_id;
#else
	if (type == COMMIT_NEW || (type & COMMIT_DIAG_ADDREM) || (type & COMMIT_ORDER)) {
		int i = 0;
		for (auto& event : Events)
			event.Row = i++;
	}

	PushState({desc, &amend_id, single_line});

	AnnounceCommit(type, single_line);

	return amend_id;
#endif
}
""",
    c,
)
write("ass_file.cpp", c)


# ---------- ass_override.cpp ----------
OVERRIDE_TEMPLATE = """#include "ass_dialogue.h"

// vendored: 去掉 utils.h（wx 依赖），内联需要的 mid()/float_to_string()
template<typename T> inline T mid(T a, T b, T c) {
	return a > b ? a : (b > c ? c : b);
}

inline std::string float_to_string(double val, int precision = 3) {
	char buf[64];
	snprintf(buf, sizeof(buf), "%.*f", precision, val);
	std::string s(buf);
	size_t pos = s.find_last_not_of("0");
	if (pos != s.find(".")) ++pos;
	s.erase(begin(s) + pos, end(s));
	return s;
}
"""
c = read("Aegisub/src/ass_override.cpp")
c = replace_all(
    c,
    '#include "ass_dialogue.h"\n\n#include "utils.h"',
    OVERRIDE_TEMPLATE,
)
write("ass_override.cpp", c)


# 校验：vendor 文件不应再包含 wx/options 依赖
for name in ("ass_dialogue.cpp", "ass_style.cpp", "ass_file.cpp", "ass_override.cpp"):
    content = read(os.path.join("native/src/vendor", name))
    for bad in ("utils.h", "wx/", "OPT_GET", "options.h", "project.h", "async_video_provider.h"):
        if bad in content:
            print("WARN: %s still references %s" % (name, bad))
print("done")
