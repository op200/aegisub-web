# Aegisub Web —— 原生核心（WASM）构建
#
# 目标：把 Aegisub 的 wx-free 文档核心编译成单线程 WASM 模块，
# 实现 wasm/aegisub_core_api.h 定义的 C ABI，替换 Web Worker 中的 TypeScript 核心。
#
# 依赖工具链：
#   - Emscripten (emsdk)，建议 3.1.6x+
#   - CMake 3.20+
#   - Ninja
#
# 构建：
#   emcmake cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build build
#   注意：AI 沙箱内 emcc 会因写 C:\emsdk cache lock 被拦，需在沙箱外跑 ninja。
#   产物：SINGLE_FILE=1 下 wasm 内嵌进单个 build/aegisub_core_wasm.js，
#   需手动复制到 public/wasm/aegisub_core.js（worker 按 baseUrl+wasm/ 路径加载）。
#
# 说明：
#   - 源文件直接引用工作区内的 Aegisub 克隆（../Aegisub），不复制源码。
#   - Aegisub 中与 wxWidgets 强耦合的文件（options.h / project.h 等）不在本列表内；
#     需要的精简副本放在 native/src/vendor/ 下（见 README.md 的 vendoring 策略）。
#   - 若某个上游文件依赖缺失，优先在 vendor/ 提供最小替代，而不是修改 Aegisub 源码。

cmake_minimum_required(VERSION 3.20)
project(aegisub_core C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Emscripten 专属链接选项（仅作用于 wasm 可执行目标）
if(DEFINED EMSCRIPTEN)
  set(WASM_LINK_OPTIONS
    -sMODULARIZE=1
    -sEXPORT_NAME=createAegisubCore
    -sEXPORT_ES6=1
    -sSINGLE_FILE=1
    -sALLOW_MEMORY_GROWTH=1
    -sEXPORTED_FUNCTIONS=_aegisub_core_abi_version,_aegisub_document_create,_aegisub_document_destroy,_aegisub_document_open,_aegisub_document_state_json,_aegisub_document_apply_json,_aegisub_document_undo,_aegisub_document_redo,_aegisub_document_notify_selection,_aegisub_document_notify_text_selection,_aegisub_document_export,_aegisub_document_search,_aegisub_document_replace_all,_aegisub_document_mark_saved,_aegisub_document_configure,_aegisub_core_free,_aegisub_core_last_error,_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=allocateUTF8,UTF8ToString,lengthBytesUTF8,stringToUTF8,HEAPU8,HEAP32,HEAP8,getValue,writeArrayToMemory
    -sENVIRONMENT=web,worker,node
  )
endif()

set(AEGISUB_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../Aegisub")

# 优先使用 native/src/vendor/ 下的精简副本（针对 wx/UI 强耦合的上游文件）
function(add_core_sources out_var)
  set(_result "")
  foreach(src IN LISTS ARGN)
    get_filename_component(_name "${src}" NAME)
    set(_vendor "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/${_name}")
    if(EXISTS "${_vendor}")
      list(APPEND _result "${_vendor}")
    else()
      list(APPEND _result "${src}")
    endif()
  endforeach()
  set(${out_var} ${_result} PARENT_SCOPE)
endfunction()

add_core_sources(CORE_SOURCES
  # ---- ABI 实现 ----
  "${CMAKE_CURRENT_SOURCE_DIR}/src/aegisub_core_api.cpp"

  # ---- Aegisub 文档模型（wx-free；有 vendor 副本时用 vendor）----
  "${AEGISUB_ROOT}/src/ass_entry.cpp"
  "${AEGISUB_ROOT}/src/ass_dialogue.cpp"
  "${AEGISUB_ROOT}/src/ass_style.cpp"
  "${AEGISUB_ROOT}/src/ass_parser.cpp"
  "${AEGISUB_ROOT}/src/ass_file.cpp"
  "${AEGISUB_ROOT}/src/ass_attachment.cpp"
  "${AEGISUB_ROOT}/src/ass_karaoke.cpp"
  "${AEGISUB_ROOT}/src/ass_override.cpp"

  # ---- libaegisub 基础库（wx-free）----
  "${AEGISUB_ROOT}/libaegisub/ass/dialogue_parser.cpp"
  "${AEGISUB_ROOT}/libaegisub/ass/karaoke.cpp"
  "${AEGISUB_ROOT}/libaegisub/ass/string_codec.cpp"
  "${AEGISUB_ROOT}/libaegisub/ass/time.cpp"
  "${AEGISUB_ROOT}/libaegisub/ass/uuencode.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/character_count.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/color.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/format.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/json.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/karaoke_matcher.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/line_iterator.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/parser.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/unicode.cpp"
  # util.cpp 依赖 ICU CaseMap/Edits，且核心无引用，暂不编译
  "${AEGISUB_ROOT}/libaegisub/common/cajun/elements.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/cajun/reader.cpp"
  "${AEGISUB_ROOT}/libaegisub/common/cajun/writer.cpp"
)

add_library(aegisub_core STATIC ${CORE_SOURCES})

target_include_directories(aegisub_core PRIVATE
  # vendor 头文件优先（ICU shim、以及后续需要的 wx 替代头）
  "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/include"
  "${AEGISUB_ROOT}/src"
  "${AEGISUB_ROOT}/src/include"
  "${AEGISUB_ROOT}/libaegisub/include"
  "${AEGISUB_ROOT}/subprojects/boost"
  "${AEGISUB_ROOT}/subprojects"
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

# Aegisub 要求定义
target_compile_definitions(aegisub_core PRIVATE
  AEGISUB_USE_MEMORY_MAPPED_FILE=0
  AEGISUB_CORE_WASM=1
)

# Boost 头文件路径：Aegisub 通过 wrap 使用 boost。
# native/third_party/boost 解压的是 boost_1_83_0/boost（结构为 boost/<模块>/...），
# 所以 include 根目录是 third_party（boost 的父目录），使 #include <boost/...> 能解析。
if(EXISTS "${AEGISUB_ROOT}/subprojects/boost")
  target_include_directories(aegisub_core PRIVATE "${AEGISUB_ROOT}/subprojects")
endif()
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/boost")
  target_include_directories(aegisub_core PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
endif()

if(DEFINED EMSCRIPTEN)
  set_target_properties(aegisub_core PROPERTIES OUTPUT_NAME aegisub_core)
  add_executable(aegisub_core_wasm "${CMAKE_CURRENT_SOURCE_DIR}/src/aegisub_core_api_entry.cpp")
  target_include_directories(aegisub_core_wasm PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src" "${CMAKE_CURRENT_SOURCE_DIR}/../wasm")
  target_link_options(aegisub_core_wasm PRIVATE ${WASM_LINK_OPTIONS})
  target_link_libraries(aegisub_core_wasm aegisub_core)
endif()

# ---------------------------------------------------------------------------
# Lua 5.5 —— Automation WASM 后端
# ---------------------------------------------------------------------------
# 官方源码放在 native/third_party/lua-5.5.1（由 build_lua_wasm.ps1 下载/校验）。
# 只编译解释器与标准库，排除 lua.c / luac.c / ltests.c / onelua.c。
# 产物 lua55.js 复制到 public/wasm/，由 src/automation/backends/lua55Wasm.ts 加载。

set(LUA55_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lua-5.5.1")

file(GLOB LUA55_SOURCES "${LUA55_ROOT}/*.c")
list(FILTER LUA55_SOURCES EXCLUDE REGEX "/(lua|luac|ltests|onelua)\\.c$")

if(NOT LUA55_SOURCES)
  message(WARNING "Lua 5.5.1 sources not found under ${LUA55_ROOT}; skipping lua55_wasm")
else()
  add_library(lua55 STATIC ${LUA55_SOURCES})
  target_include_directories(lua55 PUBLIC "${LUA55_ROOT}")

  if(DEFINED EMSCRIPTEN)
    set(LUA55_WASM_LINK_OPTIONS
      -sMODULARIZE=1
      -sEXPORT_NAME=createLua55
      -sEXPORT_ES6=1
      -sSINGLE_FILE=1
      -sALLOW_MEMORY_GROWTH=1
      -sSTACK_SIZE=1048576
      -sENVIRONMENT=web,worker,node
      -sEXPORTED_FUNCTIONS=_lua_web_registry_index,_lua_web_newstate,_lua_web_close,_lua_web_newthread,_lua_web_main_handle,_lua_web_openlibs,_lua_web_gettop,_lua_web_settop,_lua_web_pushvalue,_lua_web_pop,_lua_web_insert,_lua_web_remove,_lua_web_replace,_lua_web_absindex,_lua_web_xmove,_lua_web_type,_lua_web_typename,_lua_web_isnil,_lua_web_isnumber,_lua_web_isstring,_lua_web_istable,_lua_web_isboolean,_lua_web_isfunction,_lua_web_isuserdata,_lua_web_isyieldable,_lua_web_toboolean,_lua_web_tonumber,_lua_web_tointeger,_lua_web_tolstring,_lua_web_touserdata,_lua_web_pushnil,_lua_web_pushboolean,_lua_web_pushnumber,_lua_web_pushinteger,_lua_web_pushstring,_lua_web_pushlightuserdata,_lua_web_newuserdata,_lua_web_newtable,_lua_web_getfield,_lua_web_setfield,_lua_web_getglobal,_lua_web_setglobal,_lua_web_rawget,_lua_web_rawset,_lua_web_rawgeti,_lua_web_rawseti,_lua_web_rawlen,_lua_web_setmetatable,_lua_web_next,_lua_web_pushclosure,_lua_web_pcall,_lua_web_call,_lua_web_resume,_lua_web_ref,_lua_web_loadbuffer,_lua_web_dostring,_lua_web_set_error,_lua_web_buffer,_lua_web_buffer2,_lua_web_strlen_addr,_lua_web_next_ref,_lua_web_getstack,_lua_web_getinfo,_lua_web_dbg_str,_lua_web_dbg_int
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAP8,HEAP16,HEAPU16,HEAPF32,HEAPF64,getValue,setValue
    )
    add_executable(lua55_wasm "${CMAKE_CURRENT_SOURCE_DIR}/src/lua_web_api.cpp")
    set_target_properties(lua55_wasm PROPERTIES OUTPUT_NAME lua55)
    target_include_directories(lua55_wasm PRIVATE "${LUA55_ROOT}")
    target_link_options(lua55_wasm PRIVATE ${LUA55_WASM_LINK_OPTIONS})
    target_link_libraries(lua55_wasm lua55)
  endif()
endif()
