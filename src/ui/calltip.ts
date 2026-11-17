// agi::GetCalltip 的 web 版（libaegisub/common/calltip_provider.cpp）。
// 输入为 TokenizeDialogueBody 的 token 序列与光标位置（UTF-16 偏移）。

import { tokenizeDialogueBody, type AssToken } from './assHighlight'

interface Proto {
  name: string
  args: string
}

// NOTE: 同名 tag 按参数数量排序（源码注释）
const PROTO_1: Proto[] = [
  { name: 'K', args: '\\KDuration' },
  { name: 'a', args: '\\aAlignment' },
  { name: 'b', args: '\\bWeight' },
  { name: 'c', args: '\\cColour' },
  { name: 'i', args: '\\i1/0' },
  { name: 'k', args: '\\kDuration' },
  { name: 'p', args: '\\pExponent' },
  { name: 'q', args: '\\qWrap Style' },
  { name: 'r', args: '\\rStyle' },
  { name: 's', args: '\\s1/0' },
  { name: 't', args: '\\t(Acceleration,Tags)' },
  { name: 't', args: '\\t(Start Time,End Time,Tags)' },
  { name: 't', args: '\\t(Start Time,End Time,Acceleration,Tags)' },
  { name: 'u', args: '\\u1/0' },
]

const PROTO_2: Proto[] = [
  { name: '1a', args: '\\1aAlpha' },
  { name: '1c', args: '\\1cColour' },
  { name: '2a', args: '\\2aAlpha' },
  { name: '2c', args: '\\2cColour' },
  { name: '3a', args: '\\3aAlpha' },
  { name: '3c', args: '\\3cColour' },
  { name: '4a', args: '\\4aAlpha' },
  { name: '4c', args: '\\4cColour' },
  { name: 'an', args: '\\anAlignment' },
  { name: 'be', args: '\\beStrength' },
  { name: 'fe', args: '\\feEncoding' },
  { name: 'fn', args: '\\fnFont Name' },
  { name: 'fr', args: '\\frAngle' },
  { name: 'fs', args: '\\fsFont Size' },
  { name: 'kf', args: '\\kfDuration' },
  { name: 'ko', args: '\\koDuration' },
]

const PROTO_3: Proto[] = [
  { name: 'fax', args: '\\faxFactor' },
  { name: 'fay', args: '\\fayFactor' },
  { name: 'frx', args: '\\frxAngle' },
  { name: 'fry', args: '\\fryAngle' },
  { name: 'frz', args: '\\frzAngle' },
  { name: 'fsp', args: '\\fspSpacing' },
  { name: 'org', args: '\\org(X,Y)' },
  { name: 'pbo', args: '\\pboOffset' },
  { name: 'pos', args: '\\pos(X,Y)' },
]

const PROTO_4: Proto[] = [
  { name: 'blur', args: '\\blurStrength' },
  { name: 'bord', args: '\\bordWidth' },
  { name: 'clip', args: '\\clip(Command)' },
  { name: 'clip', args: '\\clip(Scale,Command)' },
  { name: 'clip', args: '\\clip(X1,Y1,X2,Y2)' },
  { name: 'fad', args: '\\fad(Start Time,End Time)' },
  {
    name: 'fade',
    args: '\\fade(Start Alpha,Middle Alpha,End Alpha,Start In,End In,Start Out,End Out)',
  },
  { name: 'fscx', args: '\\fscxScale' },
  { name: 'fscy', args: '\\fscyScale' },
  { name: 'move', args: '\\move(X1,Y1,X2,Y2)' },
  { name: 'move', args: '\\move(X1,Y1,X2,Y2,Start Time,End Time)' },
  { name: 'shad', args: '\\shadDepth' },
]

const PROTO_5: Proto[] = [
  { name: 'alpha', args: '\\alphaAlpha' },
  { name: 'iclip', args: '\\iclip(Command)' },
  { name: 'iclip', args: '\\iclip(Scale,Command)' },
  { name: 'iclip', args: '\\iclip(X1,Y1,X2,Y2)' },
  { name: 'xbord', args: '\\xbordWidth' },
  { name: 'xshad', args: '\\xshadDepth' },
  { name: 'ybord', args: '\\ybordWidth' },
  { name: 'yshad', args: '\\yshadDepth' },
]

const ALL_PROTOS = [PROTO_1, PROTO_2, PROTO_3, PROTO_4, PROTO_5]

export interface Calltip {
  /** 完整提示文本，如 \pos(X,Y) */
  text: string
  /** text 中当前参数的高亮范围 [start, end) */
  highlightStart: number
  highlightEnd: number
  /** 标签名在整行文本中的偏移（\ 之后），用于定位浮层 */
  tagPosition: number
}

/**
 * agi::GetCalltip：光标位于 override 标签内时返回该标签的调用提示。
 * pos 为 UTF-16 偏移；tokens 必须与 text 对应。
 */
export function getCalltip(tokens: AssToken[], text: string, pos: number): Calltip | null {
  let idx = 0
  let tagNameIdx = 0
  let commas = 0
  for (; idx < tokens.length && pos > 0; ++idx) {
    switch (tokens[idx].type) {
      case 'COMMENT':
      case 'OVR_END':
        tagNameIdx = 0
        break
      case 'TAG_NAME':
        tagNameIdx = idx
        commas = 0
        break
      case 'ARG_SEP':
        ++commas
        break
      default:
        break
    }
    pos -= Math.min(pos, tokens[idx].length)
  }

  // 未命中标签，或 override 块在光标前已结束
  if (tagNameIdx === 0) return null

  let tagNameStart = 0
  for (let i = 0; i < tagNameIdx; i++) tagNameStart += tokens[i].length
  const tagNameLength = tokens[tagNameIdx].length
  if (tagNameLength > 5) return null

  const tagName = text.slice(tagNameStart, tagNameStart + tagNameLength)
  const protos = ALL_PROTOS[tagNameLength - 1]
  // 源码在按字典序排序的表里线性查找第一个以 tagName 开头的原型
  let protoIndex = protos.findIndex((item) => item.name >= tagName)
  if (protoIndex < 0) return null
  if (!protos[protoIndex].name.startsWith(tagName)) return null

  // 多重载：统计完整参数数量，选择参数足够的最短重载
  if (protoIndex + 1 < protos.length && protos[protoIndex + 1].name.startsWith(tagName)) {
    let args = commas + 1
    for (let i = idx + 1; i < tokens.length; i++) {
      const type = tokens[i].type
      if (type === 'ARG_SEP') ++args
      else if (type !== 'ARG' && type !== 'WHITESPACE') break
    }
    const argCount = (item: Proto) => item.args.split(',').length
    while (
      protoIndex + 1 < protos.length &&
      protos[protoIndex + 1].name.startsWith(tagName) &&
      args > argCount(protos[protoIndex])
    )
      ++protoIndex
  }

  const proto = protos[protoIndex]
  let highlightStart = tagNameLength + 1
  let highlightEnd: number
  if (proto.args[highlightStart] !== '(') {
    highlightEnd = proto.args.length
  } else {
    let start = tagNameLength + 2 // 跳过反斜杠与左括号
    for (; commas > 0; --commas) {
      const comma = proto.args.indexOf(',', start)
      // 已经越过最后一个参数：不显示 calltip
      if (comma < 0) return null
      start = comma + 1
    }
    highlightStart = start
    const end = proto.args.indexOf(',', start)
    highlightEnd = end >= 0 ? end : proto.args.length - 1 // -1 为右括号
  }

  return { text: proto.args, highlightStart, highlightEnd, tagPosition: tagNameStart }
}

/** 便捷入口：从整行文本与光标偏移直接计算 */
export function calltipAt(text: string, pos: number): Calltip | null {
  return getCalltip(tokenizeDialogueBody(text), text, pos)
}
