/**
 * VFS 令牌与路径工具单测（对齐 libaegisub/common/path.cpp 的语义）。
 * 只覆盖纯函数；IndexedDB 相关读写依赖浏览器环境，不在此测。
 */
import { describe, expect, it } from 'vitest'

import {
  basename,
  dirname,
  extname,
  joinPath,
  normalizePath,
  stem,
  vfsDecode,
  vfsEncode,
} from './vfs'

describe('vfsDecode（Path::Decode，path.cpp L76-86）', () => {
  it('展开便携根令牌 ?user/?cache/?state/?data 到虚拟根', () => {
    expect(vfsDecode('?user/config.json')).toBe('/config.json')
    expect(vfsDecode('?data/automation/autoload')).toBe('/automation/autoload')
    expect(vfsDecode('?cache/ffms2cache')).toBe('/ffms2cache')
    expect(vfsDecode('?state/autosave')).toBe('/autosave')
    expect(vfsDecode('?user')).toBe('/')
  })

  it('?local 作为 ?cache 遗留别名仍可解码', () => {
    expect(vfsDecode('?local/ffms2cache')).toBe('/ffms2cache')
  })

  it('?dictionary 派生为 /dictionaries', () => {
    expect(vfsDecode('?dictionary')).toBe('/dictionaries')
    expect(vfsDecode('?dictionary/x.dic')).toBe('/dictionaries/x.dic')
  })

  it('未设置令牌（?script/?temp）按源码原样返回', () => {
    expect(vfsDecode('?script/foo.lua')).toBe('?script/foo.lua')
    expect(vfsDecode('?temp/x.ass')).toBe('?temp/x.ass')
  })

  it('非令牌路径原样归一化', () => {
    expect(vfsDecode('/plain/path')).toBe('/plain/path')
    expect(vfsDecode('/a//b/../c')).toBe('/a/c')
  })
})

describe('vfsEncode（Path::Encode，path.cpp L132-148）', () => {
  it('取最短令牌前缀', () => {
    expect(vfsEncode('/dictionaries/x.dic')).toBe('?dictionary/x.dic')
  })

  it('平局保留令牌数组序靠前者（?cache 先于 ?data/?state/?user）', () => {
    expect(vfsEncode('/autosave/a.ass')).toBe('?cache/autosave/a.ass')
  })

  it('根路径编码为令牌本身（?local 不再产出）', () => {
    expect(vfsEncode('/')).toBe('?cache')
  })
})

describe('路径工具', () => {
  it('normalizePath 合并斜杠并消解 . 与 ..', () => {
    expect(normalizePath('a/b')).toBe('/a/b')
    expect(normalizePath('/a//b/./c/../d')).toBe('/a/b/d')
    expect(normalizePath('/')).toBe('/')
  })

  it('joinPath 拼接', () => {
    expect(joinPath('/', 'automation/autoload')).toBe('/automation/autoload')
    expect(joinPath('/autosave', 'a.ass')).toBe('/autosave/a.ass')
  })

  it('dirname/basename/extname/stem', () => {
    expect(dirname('/a/b/c.ass')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
    expect(dirname('/')).toBe('/')
    expect(basename('/a/b/c.ass')).toBe('c.ass')
    expect(extname('/a/b/c.ass')).toBe('.ass')
    expect(extname('/a/.bashrc')).toBe('')
    expect(stem('/a/b/c.ass')).toBe('c')
  })
})
