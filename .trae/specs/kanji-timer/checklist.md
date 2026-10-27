# 汉字K值配对器验收清单

- [x] 选项 `Tool/Kanji Timer/Interpolation` 默认值为 `true`，且与 `default_config.json` 一致
- [x] `tool/time/kanji` 打开真实对话框，不再显示说明占位
- [x] 未选样式、样式相同、Accept 未分组完三种错误提示与源码文案一致
- [x] Start 后按 Interpolate 自动匹配出第一组，且 Start 总是清空未提交的已接受行
- [x] Right/Left/Up/Down/Enter/Backspace 六个快捷键行为与源码一致
- [x] Skip Source/Dest、Go Back a Line 的行查找与回退语义与源码一致
- [x] Accept Line 收集目标行，Close 时一次性提交，undo 标签为 `kanji timing`
- [x] Interpolate 勾选状态在重新打开对话框后保持
- [x] 显示区布局正确：配对组上下对齐、当前选择高亮、超宽时保持尾部可见
- [x] `pnpm check` 全部通过
