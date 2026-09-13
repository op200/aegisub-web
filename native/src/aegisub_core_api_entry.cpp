// Emscripten 模块入口。
// 该文件仅为确保 C ABI 符号被链接进 WASM 模块（配合 -sEXPORTED_FUNCTIONS）。
#include "../../wasm/aegisub_core_api.h"

extern "C" {
// 引用所有 ABI 符号，防止静态库链接时被裁剪
__attribute__((used)) static const void* const kAegisubAbiRefs[] = {
    reinterpret_cast<const void*>(&aegisub_core_abi_version),
    reinterpret_cast<const void*>(&aegisub_document_create),
    reinterpret_cast<const void*>(&aegisub_document_destroy),
    reinterpret_cast<const void*>(&aegisub_document_open),
    reinterpret_cast<const void*>(&aegisub_document_state_json),
    reinterpret_cast<const void*>(&aegisub_document_apply_json),
    reinterpret_cast<const void*>(&aegisub_document_undo),
    reinterpret_cast<const void*>(&aegisub_document_redo),
    reinterpret_cast<const void*>(&aegisub_document_export),
    reinterpret_cast<const void*>(&aegisub_document_mark_saved),
    reinterpret_cast<const void*>(&aegisub_document_configure),
    reinterpret_cast<const void*>(&aegisub_core_free),
    reinterpret_cast<const void*>(&aegisub_core_last_error),
};
}
