# 汉字K值配对器（Kanji Timer）功能实现规范

## 1. 背景

`tool/time/kanji` 的工具栏图标已修复，但命令打开后仍是 `ToolInfoDialog` 占位文案
（[App.tsx 2911-2919](file:///c:/Users/Administrator/Documents/Web/aegisub-web/src/ui/App.tsx#L2911-L2919)）。
本次要把 `Aegisub/src/dialog_kara_timing_copy.cpp` 的完整功能移植到 Web。

核心算法已按源码完成并通过 20 个移植测试：

- `src/core/kanaTable.ts`：`kana_table.cpp` 的假名↔罗马字对照表
- `src/core/karaokeMatcher.ts`：`AutoMatchKaraoke` + `KaraokeMatcher`
- `src/core/dialogueBlocks.ts`：新增 `strippedText()`（`AssDialogue::GetStrippedText`）
- `src/core/karaokeMatcher.test.ts`：20 个测试通过

本次只做 UI 层接线、对话框状态机、样式与选项默认值。

## 2. 目标

1. 点击 `tool/time/kanji` 打开真正的汉字K值配对器对话框。
2. 完整复刻 `DialogKanjiTimer` 的交互：
   - 源/目标样式选择
   - Start / Link / Unlink / Skip Source Line / Skip Dest Line / Go Back a Line / Accept Line / Close
   - Right/Left/Up/Down/Enter/Backspace 快捷键
   - `Attempt to interpolate kanji` 选项（打开时读取、关闭时写回）
   - 关闭时一次性提交所有已接受的目标行（undo 标签 `kanji timing`）
3. 显示区复刻源码的「已配对组框 + 当前选择高亮 + 未配对尾部」。

## 3. 源码语义（必须逐条对齐）

来源：[dialog_kara_timing_copy.cpp](file:///c:/Users/Administrator/Documents/Web/aegisub-web/Aegisub/src/dialog_kara_timing_copy.cpp)

### 3.1 行查找

- `FindNextStyleMatch(from, style)`：从 `from` 的**下一行**开始向后找
  `Style == style && Text 非空` 的行；`from == null` 时返回 `null`。
- `FindPrevStyleMatch(from, style)`：从 `from` 的**前一行**开始向前找同样条件的行。
- 注释行不排除（源码 `find_next` 不检查 Comment）。

### 3.2 Start

- 源样式为空或目标样式为空 → 报错 `Select source and destination styles first.`
- 两样式相同 → 报错 `The source and destination styles must be different.`
- 成功时：
  1. 源/目标行都先指向第一条事件行；
  2. 若第一条的样式不等于所选样式，则各自向后查找；
  3. `ResetForNewLine()`。
- **无论成功或失败，最后都清空 `LinesToChange`**（已接受但未提交的行被丢弃）。

### 3.3 ResetForNewLine

- 源或目标任一为 `null` → 两者都置 `null`，并响铃。
- `SetInputData(src, dst)`：
  - 源：`parseKaraokeSyllables(src.text, src.startMs)`；源为 `null` 时传 `[]`
  - 目标：`strippedText(dst.text)`；目标为 `null` 时传 `''`
- 若 Interpolate 勾选 → `autoMatchJapanese()`。
- 焦点移到显示区。

### 3.4 命令

- Link：`acceptMatch()` 成功 → 若 Interpolate 勾选则 `autoMatchJapanese()`；失败 → 响铃。
- Unlink：`undoMatch()` 失败 → 响铃；成功后**不**自动匹配。
- Skip Source Line：`FindNextStyleMatch(currentSource, sourceStyle)` 后 Reset。
- Skip Dest Line：`FindNextStyleMatch(currentDestination, destStyle)` 后 Reset。
- Go Back a Line：先 `LinesToChange.pop_back()`（如有），再各自 `FindPrevStyleMatch` 后 Reset。
- Accept Line：
  - 目标行为 `null` → 直接返回；
  - `remainingSource() > 0` → 报错 `Group all of the source text.`；
  - 否则把 `(当前目标行 id, matcher.getOutputLine())` 追加进 `LinesToChange`，
    然后源/目标各自向后查找并 Reset。
- Close：写回 `Tool/Kanji Timer/Interpolation` → 按顺序提交 `LinesToChange` → 关闭。

### 3.5 快捷键

仅在焦点不落在表单控件（`button/select/input/textarea`）时处理：

| 键 | 行为 |
|---|---|
| Right | IncreaseDestinationMatch |
| Left | DecreaseDestinationMatch |
| Up | IncreaseSourceMatch |
| Down | DecreaseSourceMatch |
| Enter | `remainingSource() == 0 && remainingDestination() == 0` → Accept Line，否则 Link |
| Backspace | Unlink |
| Escape | 关闭（由 `Dialog` 的 ESC 栈调用同一保存关闭逻辑） |

处理时 `preventDefault()` + `stopPropagation()`，避免按钮被 Enter 二次触发、页面滚动。

## 4. 实现方案

### 4.1 选项默认值

文件：[src/config/options.ts](file:///c:/Users/Administrator/Documents/Web/aegisub-web/src/config/options.ts#L314-L363)

在 `DEFAULT_CONFIG.Tool` 中新增（对应 `libresrc/default_config.json:477-479`）：

```ts
'Kanji Timer': { Interpolation: true },
```

### 4.2 新建对话框组件

文件：`src/ui/components/KanjiTimerDialog.tsx`（新建）

#### Props

```ts
export interface KanjiTimerDialogProps {
  cues: SubtitleCue[]
  styles: string[]
  onClose: () => void
  onApply: (commands: CoreCommand[], label: string) => void
}
```

#### 状态

```ts
const matcherRef = useRef<KaraokeMatcher | null>(null) // 懒初始化
const [, forceRender] = useReducer((n: number) => n + 1, 0)
const displayRef = useRef<HTMLDivElement>(null)
const paneRef = useRef<HTMLDivElement>(null)

const [sourceStyle, setSourceStyle] = useState('')       // 空串 = 未选择
const [destStyle, setDestStyle] = useState('')
const [interpolate, setInterpolate] = useState(() => getOptionBool('Tool/Kanji Timer/Interpolation'))
const [currentSourceId, setCurrentSourceId] = useState<string | null>(null)
const [currentDestId, setCurrentDestId] = useState<string | null>(null)
const [pending, setPending] = useState<{ id: string; text: string }[]>([])
const [error, setError] = useState<string | null>(null)
const [displayFocused, setDisplayFocused] = useState(false)
```

#### 行定位辅助（组件内）

```ts
function findNextStyleMatch(cues, fromIndex, style): number | null // 从 fromIndex+1 向后
function findPrevStyleMatch(cues, fromIndex, style): number | null // 从 fromIndex-1 向前
```

匹配条件：`cue.style === style && cue.text !== ''`。

#### 行为函数（组件内，使用 cue id 而非指针）

- `resetForNewLine(sourceId, destId)`：按 3.3 执行；直接操作 matcher，最后 `forceRender()` 并 focus 显示区。
- `handleStart()`、`handleLink()`、`handleUnlink()`、`handleSkipSource()`、`handleSkipDest()`、
  `handleGoBack()`、`handleAcceptLine()`、`handleClose()`：按 3.2/3.4 执行。
- `handleClose()`：
  ```ts
  setOption('Tool/Kanji Timer/Interpolation', interpolate)
  if (pending.length) {
    onApply(pending.map(({ id, text }) => ({ type: 'updateCue', id, patch: { text } })), 'kanji timing')
  }
  onClose()
  ```
  所有关闭入口（footer Close、标题栏 X、ESC）都走此函数。
- `handleKeyDown(event)`：按 3.5 映射；`event.target.closest('button,select,input,textarea')` 时直接返回（Escape 除外，交给 `Dialog`）。
- `playBell()`：模块级 WebAudio 短音（880Hz / 60ms），`typeof AudioContext === 'undefined'` 时静默跳过；用于源码 `wxBell()` 的三处。

#### 渲染结构

```
<Dialog title={tPlain('Kanji timer')} onClose={handleClose} footer={<button>Close</button>}>
  <div className="kanji-body" onKeyDown={handleKeyDown}>
    {error && <p className="dialog-error">{error}</p>}

    <fieldset class="dialog-fieldset kanji-display-box">
      <legend>Text</legend>
      <div class="kanji-display" tabIndex={0} ref={displayRef}
           onFocus={...} onBlur={...}>
        <div class="kanji-labels">
          <span class="kanji-label">Source: </span>
          <span class="kanji-label">Dest: </span>
        </div>
        <div class="kanji-pane" ref={paneRef}>
          {groups.map((g, i) => (
            <Fragment key={i}>
              <div class="kanji-cell">{g.src.map(s => <span class="kanji-box">{s.text}</span>)}</div>
              <div class="kanji-cell"><span class="kanji-box">{g.dst}</span></div>
            </Fragment>
          ))}
          <div class="kanji-cell kanji-tail">
            {selSrc.map(s => <span class="kanji-box selected">...)}   // 当前源选择
            {restSrc.map(s => <span class="kanji-box">...)}         // 未配对源
          </div>
          <div class="kanji-cell kanji-tail">
            {selDst && <span class="kanji-box selected">{selDst}</span>}
            {restDst && <span class="kanji-box">{restDst}</span>}
          </div>
        </div>
      </div>
      <label class="dialog-check">
        <input type="checkbox" checked={interpolate} onChange={...} />
        Attempt to &interpolate kanji
      </label>
    </fieldset>

    <div class="kanji-bottom">
      <div class="kanji-bottom-left">
        <fieldset class="dialog-fieldset">
          <legend>Styles</legend>
          <div class="kanji-style-grid">
            <label>Source: </label><select value={sourceStyle}>…</select>
            <label>Dest: </label><select value={destStyle}>…</select>
          </div>
        </fieldset>
        <fieldset class="dialog-fieldset kanji-help">
          <legend>Shortcut Keys</legend>
          <p>源码快捷键说明全文</p>
        </fieldset>
      </div>
      <fieldset class="dialog-fieldset kanji-commands">
        <legend>Commands</legend>
        <button>Start!</button> … <button>Accept Line</button>
      </fieldset>
    </div>
  </div>
</Dialog>
```

要点：

- 显示区用 **2 行 × 自动列** 的 CSS Grid（`grid-auto-flow: column; grid-template-rows: auto auto`），
  每个配对组占一列的两格，保证上下两行按组左对齐；尾部选择/未配对整体占一列，上下两行同样对齐。
- 配对组内每个源音节各自一个框；目标文本一个框。
- 当前源选择、目标选择用高亮底色；未配对用普通底色。
- 显示区横向内容溢出时，通过 `useEffect`（无依赖，每次渲染后）设置
  `pane.scrollLeft = pane.scrollWidth`，保持当前选择/尾部可见（等价于源码「跳过旧组 + 箭头」）。
- 显示区 `tabIndex=0`，`ResetForNewLine` 后 focus；未聚焦时标签使用 `--muted`，聚焦时使用 `--text`。
- 文案全部走 `tPlain`，并保持源码 msgid 原文（含 `&` 的按钮/复选框由 `tPlain` 去热键标记后命中 zh_CN 的 loose 索引）。
- 错误用对话框内 `.dialog-error` 内联显示（项目既有做法），替代 `wxMessageBox`。
- 样式下拉为只读 `<select>`，首项为空（与源码初始 `""` 一致），选项顺序取 `styles`。

### 4.3 App 接线

文件：[src/ui/App.tsx](file:///c:/Users/Administrator/Documents/Web/aegisub-web/src/ui/App.tsx)

1. 在对话框组件导入清单中加入 `KanjiTimerDialog`。
2. 用以下内容替换 2911-2919 的 `ToolInfoDialog` 占位：

```tsx
{dialog === 'kanji-timer' && core && (
  <KanjiTimerDialog
    cues={core.document.cues}
    styles={core.document.styles.map((style) => style.name)}
    onClose={() => setDialog(null)}
    onApply={(commands, label) => void apply(commands, label)}
  />
)}
```

`ToolInfoDialog` 仍被 spellcheck 使用，导入保留。

### 4.4 样式

文件：[src/ui/styles.css](file:///c:/Users/Administrator/Documents/Web/aegisub-web/src/ui/styles.css)

在现有 dialog 样式区间后追加 `.kanji-*`：

- `.kanji-body`：`width: min(560px, calc(100vw - 40px))`，纵向 flex，gap 8px，padding 10px
- `.kanji-display-box`：`gap: 6px`
- `.kanji-display`：`display: grid; grid-template-columns: max-content minmax(0,1fr); gap: 3px; outline: none; user-select: none; font-size: 12px`
- `.kanji-labels`：`display: grid; grid-template-rows: auto auto; row-gap: 3px; padding: 2px 0`
- `.kanji-label`：同 `.kanji-box` 的 border/padding/line-height 度量（透明边框）保证行高对齐；
  默认 `color: var(--muted)`，`.kanji-display:focus .kanji-label { color: var(--text) }`
- `.kanji-pane`：`display: grid; grid-auto-flow: column; grid-template-rows: auto auto; grid-auto-columns: max-content; column-gap: 3px; row-gap: 3px; overflow: hidden; border-top/bottom: 1px solid var(--border-strong); padding: 2px 0`；
  中间横线用 `background-image: linear-gradient(var(--border-strong), var(--border-strong))` 定位在 50%
- `.kanji-cell`：`display: flex; align-items: flex-start; min-width: 0`
- `.kanji-tail`：`margin-left: 4px`（对应源码组间 +4px）
- `.kanji-box`：`border: 1px solid var(--border-strong); background: var(--control); color: var(--text); padding: 1px 2px; line-height: 1.35; white-space: pre`
- `.kanji-box + .kanji-box { margin-left: -1px }`（相邻框共享边框，对应源码 tw+3 步进）
- `.kanji-box.selected { background: var(--blue); color: #fff }`
- `.kanji-bottom`：横向 flex，gap 8px，`align-items: stretch`
- `.kanji-bottom-left`：纵向 flex，`flex: 1`，gap 8px
- `.kanji-style-grid`：2×2 grid，`grid-template-columns: max-content minmax(0,1fr)`，gap 6px
- `.kanji-help p`：`white-space: pre-line; font-size: 11px; text-align: center; margin: 0`
- `.kanji-commands`：纵向 flex，`justify-content: center; gap: 6px`；按钮 `white-space: nowrap`

## 5. 有意偏差（需在实现中保持）

1. **所有关闭路径都保存**：源码标题栏 X 只关闭不提交，ESC 与 Close 才提交。Web 统一走 `handleClose`，
   避免用户丢失已接受的行。
2. **消息框改为内联错误**：三条报错文案不变，但显示为 `.dialog-error`。
3. **自动横向滚动**：用 `scrollLeft = scrollWidth` 替代源码逐个跳过旧组并绘制箭头的算法，
   视觉效果一致（当前选择始终可见），但不绘制省略箭头。
4. **响铃**：用 WebAudio 短音替代 `wxBell()`；不支持时静默。
5. **焦点控件过滤**：Web 中按键会从下拉框/按钮冒泡到容器，必须忽略这些来源，避免与原生控件行为冲突。

## 6. 验证

### 6.1 静态检查

```powershell
pnpm check
```

必须通过 `oxfmt --check`、`oxlint`、`tsc -b`、`vitest run src`；
现有 `karaokeMatcher.test.ts` 20 个用例保持通过。

### 6.2 浏览器实测

1. 打开包含至少两种样式、且源行为罗马字 `\k` 卡拉OK、目标行为日文的字幕。
2. `Tools → Kanji Timer`：
   - 未选样式点 Start → 显示错误 `Select source and destination styles first.`
   - 选相同样式 → 显示错误 `The source and destination styles must be different.`
   - 选正确样式 → Start 后自动匹配出第一组（Interpolate 勾选时）。
3. 键盘：Right/Left 调目标字符数，Up/Down 调源音节数，Enter 链接并移动到下一组，Backspace 撤销。
4. 把源音节全部配对后 Enter → Accept Line 前进；未配完点 Accept Line → 显示 `Group all of the source text.`
5. Skip Source/Dest、Go Back a Line 的行为与源码一致。
6. Close 后字幕网格中的目标行文本变为 `{\kNN}...`，撤销记录标签为 `kanji timing`。
7. 重新打开对话框，Interpolate 勾选状态与上次关闭时一致。
8. 显示区内容超宽时，当前选择/尾部始终可见。

### 6.3 验收标准

- [ ] `tool/time/kanji` 打开真实对话框，不再是说明占位
- [ ] 8 个按钮 + 6 个快捷键全部按源码语义工作
- [ ] Accept 收集的目标行在 Close 时一次性提交，undo 标签 `kanji timing`
- [ ] Interpolate 选项持久化并与源码默认值 `true` 一致
- [ ] `pnpm check` 全绿
- [ ] 浏览器实测流程无报错，显示区布局正确

## 7. 批准

实现前需用户确认本规格。确认后按 `tasks.md` 顺序执行。
