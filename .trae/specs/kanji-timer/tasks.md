# 汉字K值配对器实现任务

前置：核心层已完成（`kanaTable.ts`、`karaokeMatcher.ts`、`strippedText()`、20 个测试）。

- [x] T1 新增选项默认值
  - 文件：`src/config/options.ts`
  - 在 `DEFAULT_CONFIG.Tool` 中加 `'Kanji Timer': { Interpolation: true }`
  - 对齐 `Aegisub/src/libresrc/default_config.json` 的同名键
  - 验收：`getOptionBool('Tool/Kanji Timer/Interpolation') === true`

- [x] T2 实现 `KanjiTimerDialog`
  - 新建：`src/ui/components/KanjiTimerDialog.tsx`
  - 懒初始化 `KaraokeMatcher`，用 `useReducer` 强制重渲染
  - 实现行查找：`findNextStyleMatch` / `findPrevStyleMatch`（严格从当前行之外开始、要求原文本非空）
  - 实现 `resetForNewLine`（null 双置空 + 响铃、`parseKaraokeSyllables`/`strippedText`、Interpolate 自动匹配、focus 显示区）
  - 实现 Start / Link / Unlink / Skip Source / Skip Dest / Go Back / Accept Line / Close
  - Start 无论成败都清空待提交行
  - Close 写回选项并以 label `kanji timing` 提交全部 `updateCue`
  - 键盘：Right/Left/Up/Down/Enter/Backspace；表单控件来源忽略
  - 渲染：两行分组 Grid + 当前选择高亮 + 尾部；超宽时滚到尾部
  - 验收：行为逐条符合 `spec.md` 第 3 节

- [x] T3 App 接线
  - 文件：`src/ui/App.tsx`
  - 导入 `KanjiTimerDialog`
  - 用真实对话框替换 2911-2919 行的 `ToolInfoDialog` 占位
  - 传 `cues`、`styles`（`style.name`）、`onClose`、`onApply`
  - 验收：命令打开真实对话框；`ToolInfoDialog` 仍供 spellcheck 使用

- [x] T4 对话框样式
  - 文件：`src/ui/styles.css`
  - 追加 `.kanji-body` / `.kanji-display` / `.kanji-labels` / `.kanji-label` / `.kanji-pane` /
    `.kanji-cell` / `.kanji-tail` / `.kanji-box`（含 `.selected`）/ `.kanji-bottom` /
    `.kanji-bottom-left` / `.kanji-style-grid` / `.kanji-help` / `.kanji-commands`
  - 复用主题变量：`--dialog-bg`、`--control`、`--border-strong`、`--text`、`--muted`、`--blue`
  - 验收：两组上下对齐、三横线、选中高亮、相邻框共享边框

- [x] T5 静态检查
  - 运行 `pnpm check`
  - 验收：oxfmt / oxlint / tsc / vitest 全部通过；`karaokeMatcher.test.ts` 20 用例通过

- [x] T6 浏览器实测
  - 按 `spec.md` 6.2 的 8 个步骤验证
  - 覆盖：错误提示、自动匹配、六个快捷键、Skip/Go Back、Accept 报错、Close 提交与撤销标签、
    Interpolate 持久化、超宽滚动
  - 验收：全部通过，无控制台报错（仅 favicon.ico 404 属静态资源缺失，与本功能无关）

- [x] T7 更新未完成计划
  - 文件：`未完成计划.md`
  - 已检查：其中没有汉字K值配对器相关条目，无需修改

## 执行顺序

T1 → T2 → T3 → T4 → T5 → T6 → T7

T2 与 T4 可交替进行（先结构后样式），T3 在 T2 完成后接线。
