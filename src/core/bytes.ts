/** 二进制/文本互转工具（附件、网络传输共用的 base64 与小端码流） */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** 读取 UTF-8 文本（容忍 BOM；无效序列替换为 U+FFFD） */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** 去掉 UTF-8 BOM（TextFileReader 层统一丢弃 BOM） */
export function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}
