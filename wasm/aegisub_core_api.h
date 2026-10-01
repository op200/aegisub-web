#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint32_t aegisub_document_t;

uint32_t aegisub_core_abi_version(void);
aegisub_document_t aegisub_document_create(void);
void aegisub_document_destroy(aegisub_document_t document);
int32_t aegisub_document_open(aegisub_document_t document, const uint8_t *data, size_t size, const char *source_name);
const char *aegisub_document_state_json(aegisub_document_t document);
/// 应用一批命令并（可选地）建立撤销点。
/// amend 非 0 = "修订上一次提交"（源码 AssFile::Commit 的 commitId 回传，subs_controller.cpp:
/// OnCommit 的 `commit_id == *c.commit_id+1` 判据）：仅当上一次提交由同一提交点发起、期间没有
/// 其它提交、redo 栈为空且未越过保存点时才与上一个撤销点合并；调用方须自行按源码语义判断
/// "同描述 / 同一次拖拽"（subs_edit_box.cpp:Commit 的 amend + last_commit_type、
/// visual_tool.cpp:274-276 的鼠标抬起失效），核心只认这个显式信号。
/// 命令类提交（复制行/删除/粘贴/排序等，源码未传 commitId）传 0 → 各自成点。
int32_t aegisub_document_apply_json(aegisub_document_t document, const char *commands_json, const char *label, int32_t amend);
int32_t aegisub_document_undo(aegisub_document_t document);
int32_t aegisub_document_redo(aegisub_document_t document);
const uint8_t *aegisub_document_export(aegisub_document_t document, const char *format, size_t *size);
/// 搜索：settings_json 形如 {"find":"...","field":"text|style|actor|effect","matchCase":true,"useRegex":true,"exactMatch":false,"skipTags":true}
/// 返回 JSON 数组 [{ "id": "行id", "start": 0, "end": 5, "field": "..." }, ...]，无匹配返回空数组
const char *aegisub_document_search(aegisub_document_t document, const char *settings_json);
/// 全部替换：返回替换次数
int32_t aegisub_document_replace_all(aegisub_document_t document, const char *settings_json);
/// 标记文档已保存：下一次提交不再与保存前合并（subs_controller.cpp saved_commit_id 语义）
int32_t aegisub_document_mark_saved(aegisub_document_t document);
/// 选中/活动行实时修订撤销栈顶条目（subs_controller.cpp:OnSelectionChanged/OnActiveLineChanged）。
/// selected_json 为行 id 字符串数组的 JSON（如 ["3","7"]）；active_id 为行 id 字符串或空串。
/// fire-and-forget，无响应
int32_t aegisub_document_notify_selection(aegisub_document_t document, const char *selected_json, const char *active_id);
/// 编辑框文本选区实时修订撤销栈顶条目（subs_controller.cpp:OnTextSelectionChanged）。
/// pos 为插入点（光标），sel_start/sel_end 为选区边界；Undo/Redo 后 UI 按恢复值设置 textarea 选区。
/// fire-and-forget，无响应
int32_t aegisub_document_notify_text_selection(aegisub_document_t document, int32_t pos, int32_t sel_start, int32_t sel_end);
/// 运行时配置（undo_levels = Limits/Undo Levels）
int32_t aegisub_document_configure(aegisub_document_t document, int32_t undo_levels);
void aegisub_core_free(const void *memory);
const char *aegisub_core_last_error(void);

#ifdef __cplusplus
}
#endif
