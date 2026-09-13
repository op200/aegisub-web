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
int32_t aegisub_document_apply_json(aegisub_document_t document, const char *commands_json, const char *label);
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
/// 运行时配置（undo_levels = Limits/Undo Levels）
int32_t aegisub_document_configure(aegisub_document_t document, int32_t undo_levels);
void aegisub_core_free(const void *memory);
const char *aegisub_core_last_error(void);

#ifdef __cplusplus
}
#endif
