# Aegisub 原生核心（WASM）

把 Aegisub 的 **wx-free 文档核心**直接编译成 WASM，实现 `wasm/aegisub_core_api.h` 的 C ABI，
替换 `src/workers/subtitle.worker.ts` 里的 TypeScript 核心运行时。

```
src/workers/subtitle.worker.ts  ← 换成本模块加载器（协议不变）
        │  ABI (aegisub_core_api.h)
native/src/aegisub_core_api.cpp  ← 本仓库的 ABI 实现
        │
Aegisub/ 的 wx-free 核心（直接编译）
  - src/ass_*.cpp         文档模型（AssFile / AssParser / AssDialogue / AssStyle）
  - libaegisub/ass/*       时间、标签解析、字符串编解码
  - libaegisub/common/*    工具库（json、unicode、karaoke…）
```

## 为什么能直接编译

Aegisub 的文档模型（`ass_file`、`ass_parser`、`ass_dialogue`、`ass_style` 等）几乎不依赖
wxWidgets：只有个别签名用到 `wxString`（前向声明）和 UI 专用的 `GetEncodings`。
本构建通过 `AEGISUB_CORE_WASM` 宏 + `src/vendor/` 精简副本消除这些依赖。

## 目录结构

```
native/
├── CMakeLists.txt            # Emscripten 构建（源文件引用 ../Aegisub）
├── README.md
├── src/
│   ├── aegisub_core_api.cpp  # ABI 实现（文档、撤销、JSON 投影、命令）
│   ├── aegisub_core_api_entry.cpp  # Emscripten 模块入口（可选）
│   └── vendor/               # Aegisub 中无法直接编译的文件的精简副本
└── third_party/              # vendor 的 Boost 头文件（如 subprojects/boost 缺失时）
```

## Vendoring 策略

原则：**不改 Aegisub 上游源码**。遇到与 wx/UI 强耦合的上游文件时：

1. 把该文件复制到 `native/src/vendor/`（保留原版权头）。
2. 用 `#ifdef AEGISUB_CORE_WASM` 或直接删减 UI 部分：
   - `options.h` / `OPT_GET`：`ass_file.cpp` 的 `LoadDefault` 用到，vendor 版改为硬编码
     `PlayResX=1920 / PlayResY=1080`（默认 `LoadDefault(false)` 由 ABI 层手动补全）。
   - `project.h` / `async_video_provider.h`：`ass_file.cpp` 只在前向声明层用到，
     vendor 版删除这些 include。
   - `ass_style.cpp::GetEncodings`：UI 专用，vendor 版直接空实现。
3. `CMakeLists.txt` 优先编译 `src/vendor/*.cpp`，上游同名文件不重复编译。

当前 vendor 清单（待编译迭代时逐项确认）：

| 上游文件                   | 原因                           | vendor 处理                          |
| -------------------------- | ------------------------------ | ------------------------------------ |
| `src/ass_file.cpp`         | 依赖 `options.h`/`project.h`   | 精简副本：去掉 OPT_GET、project      |
| `src/ass_style.cpp`        | `GetEncodings(wxArrayString&)` | 空实现                               |
| `src/subtitle_format*.cpp` | 格式选择对话框                 | 本阶段不编译，ASS 解析走 `AssParser` |

## 构建步骤

```powershell
# 1. 安装 Emscripten（一次性）
git clone https://github.com/emscripten-core/emsdk.git C:\emsdk
C:\emsdk\emsdk install latest
C:\emsdk\emsdk activate latest

# 2. 配置并编译
$env:Path = "C:\emsdk;" + $env:Path
emcmake cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build

# 产物
#   build/aegisub_core.js
#   build/aegisub_core.wasm
```

## 在 Web 项目中接入

1. 把 `aegisub_core.js` / `aegisub_core.wasm` 放入 `public/wasm/`。
2. 修改 `src/workers/subtitle.worker.ts`：加载 `createAegisubCore()`，
   把 `CoreRequest` 映射到 ABI 调用（`open/apply_json/undo/redo/export/state`）。
3. 协议（`src/workers/protocol.ts`）与 `CoreState`/`CoreCommand` 类型保持不变——
   ABI 返回的 JSON 状态结构与 TS 类型一致（见 `aegisub_core_api.cpp` 的 JSON 投影）。
4. 删除 `src/core/format.ts`、`runtime.ts`、`defaults.ts`、`time.ts` 及对应测试。

## 测试

Aegisub 自带 gtest（`Aegisub/tests/`）。本模块编译后应把以下测试编进 WASM 跑通以验证一致性：

- `tests/tests/time.cpp`（时间解析）
- `tests/tests/split.cpp`（事件解析）
- `tests/tests/inline_string_encoding.cpp`（标签编码）
- `tests/tests/syntax_highlight.cpp`（标签解析）
- `tests/tests/uuid.cpp`、`tests/tests/vfr.cpp`
