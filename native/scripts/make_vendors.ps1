# 生成 native/src/vendor/ 下的精简副本（把 Aegisub 中 wx/UI 强耦合的核心文件
# 复制到 vendor/ 并去掉 wx 依赖）。幂等：重复运行会重新生成。
# 用法: powershell -File native/scripts/make_vendors.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vendorDir = Join-Path $root 'native/src/vendor'
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null

function New-VendorFile {
    param([string]$Source, [string]$Name, [scriptblock]$Patch)
    $content = Get-Content (Join-Path $root $Source) -Raw
    & $Patch $content
    Set-Content (Join-Path $vendorDir $Name) $content -NoNewline
    Write-Host "vendored: $Name"
}

# ---- ass_dialogue.cpp: 去掉 utils.h（wx 依赖），内联 mid() ----
New-VendorFile -Source 'Aegisub/src/ass_dialogue.cpp' -Name 'ass_dialogue.cpp' -Patch {
    param($c)
    $c = $c -replace '#include "ass_dialogue.h"\r?\n#include "subtitle_format.h"\r?\n#include "utils.h"', @'
#include "ass_dialogue.h"
#include "subtitle_format.h"

// vendored: 去掉 utils.h（wx 依赖），内联需要的 mid() 函数
template<typename T> inline T mid(T a, T b, T c) {
	return a > b ? a : (b > c ? c : b);
}
'@
    return $c
}

# ---- ass_style.cpp: 去掉 utils.h / wx/intl.h，GetEncodings 置空 ----
New-VendorFile -Source 'Aegisub/src/ass_style.cpp' -Name 'ass_style.cpp' -Patch {
    param($c)
    $c = $c -replace '#include "subtitle_format.h"\r?\n#include "utils.h"', @'
#include "subtitle_format.h"

// vendored: 去掉 utils.h（wx 依赖），内联需要的 mid() 函数
template<typename T> inline T mid(T a, T b, T c) {
	return a > b ? a : (b > c ? c : b);
}
'@
    $c = $c -replace '(?m)^#include <wx/intl\.h>\r?\n', ''
    $c = $c -replace '(?s)void AssStyle::GetEncodings\(wxArrayString &encodingStrings\) \{.*?\r?\n\}', @'
void AssStyle::GetEncodings(wxArrayString &encodingStrings) {
#ifndef AEGISUB_CORE_WASM
	(void)encodingStrings; // vendored: UI 专用，Web 版不实现
#endif
}
'@
    return $c
}

# ---- ass_file.cpp: 去掉 options/project/async_video/context/style_storage ----
New-VendorFile -Source 'Aegisub/src/ass_file.cpp' -Name 'ass_file.cpp' -Patch {
    param($c)
    $c = $c -replace '(?m)^#include "(async_video_provider|options|project|ass_style_storage)\.h"\r?\n', ''
    $c = $c -replace '(?m)^#include "include/aegisub/context\.h"\r?\n', ''
    $c = $c -replace '(?s)if \(!OPT_GET\("Subtitle/Default Resolution/Auto"\)->GetBool\(\)\) \{.*?\r?\n\s*\}', @'
Info.emplace_back("PlayResX", "1920"); // vendored: 硬编码默认分辨率
	Info.emplace_back("PlayResY", "1080");
'@
    $c = $c -replace '(?s)\t// Add/replace any catalog styles requested.*?\r?\n\t\}', '	// vendored: 目录样式在 Web 版暂不支持'
    $c = $c -replace '(?s)void AssFile::GetEffectiveLayoutResolution\(agi::Context \*c, int &lw, int &lh\) const \{.*?\r?\n\}', @'
void AssFile::GetEffectiveLayoutResolution(agi::Context *c, int &lw, int &lh) const {
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
'@
    $c = $c -replace '(?s)int AssFile::Commit\(wxString const& desc, int type, int amend_id, AssDialogue \*single_line\) \{.*?\r?\n\}', @'
int AssFile::Commit(wxString const& desc, int type, int amend_id, AssDialogue *single_line) {
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
'@
    return $c
}

Write-Host "done"
