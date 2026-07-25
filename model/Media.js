import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import fetch from "node-fetch"

const FORMAT_INFO = {
  jpg: { mimeType: "image/jpeg", extension: ".jpg", kind: "image" },
  png: { mimeType: "image/png", extension: ".png", kind: "image" },
  gif: { mimeType: "image/gif", extension: ".gif", kind: "image" },
  webp: { mimeType: "image/webp", extension: ".webp", kind: "image" },
  bmp: { mimeType: "image/bmp", extension: ".bmp", kind: "image" },
  tiff: { mimeType: "image/tiff", extension: ".tiff", kind: "image" },
  mp4: { mimeType: "video/mp4", extension: ".mp4", kind: "video" },
  avi: { mimeType: "video/x-msvideo", extension: ".avi", kind: "video" },
  mkv: { mimeType: "video/x-matroska", extension: ".mkv", kind: "video" },
  webm: { mimeType: "video/webm", extension: ".webm", kind: "video" },
  flv: { mimeType: "video/x-flv", extension: ".flv", kind: "video" },
  wav: { mimeType: "audio/wav", extension: ".wav", kind: "audio" },
  mp3: { mimeType: "audio/mpeg", extension: ".mp3", kind: "audio" },
  ogg: { mimeType: "audio/ogg", extension: ".ogg", kind: "audio" },
  flac: { mimeType: "audio/flac", extension: ".flac", kind: "audio" },
  amr: { mimeType: "audio/amr", extension: ".amr", kind: "audio" },
  silk: { mimeType: "audio/silk", extension: ".silk", kind: "audio" },
  aac: { mimeType: "audio/aac", extension: ".aac", kind: "audio" },
  m4a: { mimeType: "audio/mp4", extension: ".m4a", kind: "audio" },
}

const EXTENSION_FORMATS = new Map([
  [".jpeg", "jpg"],
  [".jpe", "jpg"],
  [".m4v", "mp4"],
  [".mov", "mp4"],
  ...Object.entries(FORMAT_INFO).map(([format, info]) => [info.extension, format]),
])

function hasPrefix(buffer, prefix, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + prefix.length) return false
  return buffer.subarray(offset, offset + prefix.length).equals(prefix)
}

function decodeBase64(payload, label = "base64 media", maxBytes = Infinity) {
  const compact = String(payload).replace(/\s+/g, "")
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`Invalid ${label}`)
  }
  const unpadded = compact.replace(/=+$/, "")
  if (Math.floor(unpadded.length * 3 / 4) > maxBytes) {
    throw new Error(`Media exceeds ${maxBytes} byte limit`)
  }
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4)
  const buffer = Buffer.from(padded, "base64")
  if (buffer.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error(`Invalid ${label}`)
  }
  return buffer
}

function formatFromName(fileName) {
  const ext = path.extname(fileName || "").toLowerCase()
  return EXTENSION_FORMATS.get(ext) || ""
}

function formatFromMimeType(mimeType) {
  const normalized = String(mimeType || "").split(";", 1)[0].trim().toLowerCase()
  const match = Object.entries(FORMAT_INFO).find(([, info]) => info.mimeType === normalized)
  return match?.[0] || ""
}

function safeFileName(fileName, fallback = "file") {
  const normalized = path.basename(String(fileName || "").replaceAll("\\", "/")).trim()
  return normalized || fallback
}

function fileNameFromResponse(response, url) {
  const disposition = response.headers.get("content-disposition") || ""
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  const encodedName = utf8Match?.[1] || plainMatch?.[1] || ""
  if (encodedName) {
    try {
      return safeFileName(decodeURIComponent(encodedName))
    } catch {
      return safeFileName(encodedName)
    }
  }
  try {
    return safeFileName(decodeURIComponent(path.basename(url.pathname)), "file")
  } catch {
    return safeFileName(path.basename(url.pathname), "file")
  }
}

export function detectMediaFormat(buffer, fileName = "", declaredMimeType = "") {
  let format = ""

  if (hasPrefix(buffer, Buffer.from([0xff, 0xd8, 0xff]))) format = "jpg"
  else if (hasPrefix(buffer, Buffer.from("89504e470d0a1a0a", "hex"))) format = "png"
  else if (hasPrefix(buffer, Buffer.from("GIF87a")) || hasPrefix(buffer, Buffer.from("GIF89a"))) format = "gif"
  else if (hasPrefix(buffer, Buffer.from("RIFF")) && hasPrefix(buffer, Buffer.from("WEBP"), 8)) format = "webp"
  else if (hasPrefix(buffer, Buffer.from("BM"))) format = "bmp"
  else if (hasPrefix(buffer, Buffer.from("49492a00", "hex")) || hasPrefix(buffer, Buffer.from("4d4d002a", "hex"))) format = "tiff"
  else if (hasPrefix(buffer, Buffer.from("RIFF")) && hasPrefix(buffer, Buffer.from("WAVE"), 8)) format = "wav"
  else if (hasPrefix(buffer, Buffer.from("RIFF")) && hasPrefix(buffer, Buffer.from("AVI "), 8)) format = "avi"
  else if (hasPrefix(buffer, Buffer.from("ftyp"), 4) && /^M4[ABP ]/.test(buffer.subarray(8, 12).toString("ascii"))) format = "m4a"
  else if (hasPrefix(buffer, Buffer.from("ftyp"), 4)) format = "mp4"
  else if (hasPrefix(buffer, Buffer.from("1a45dfa3", "hex")) && buffer.subarray(0, 128).includes(Buffer.from("webm"))) format = "webm"
  else if (hasPrefix(buffer, Buffer.from("1a45dfa3", "hex"))) format = "mkv"
  else if (hasPrefix(buffer, Buffer.from("FLV"))) format = "flv"
  else if (hasPrefix(buffer, Buffer.from("ID3")) || (buffer?.[0] === 0xff && (buffer?.[1] & 0xe0) === 0xe0)) format = "mp3"
  else if (hasPrefix(buffer, Buffer.from("OggS"))) format = "ogg"
  else if (hasPrefix(buffer, Buffer.from("fLaC"))) format = "flac"
  else if (hasPrefix(buffer, Buffer.from("#!AMR"))) format = "amr"
  else if (hasPrefix(buffer, Buffer.from("#!SILK_V3")) || hasPrefix(buffer, Buffer.from("\x02#!SILK_V3", "binary"))) format = "silk"
  else if (buffer?.[0] === 0xff && (buffer?.[1] & 0xf6) === 0xf0) format = "aac"

  const detectedFromContent = !!format
  format ||= formatFromMimeType(declaredMimeType)
  format ||= formatFromName(fileName)
  const info = FORMAT_INFO[format]

  return {
    format: format || "",
    mimeType: info?.mimeType || String(declaredMimeType || "").split(";", 1)[0].trim() || "application/octet-stream",
    extension: info?.extension || path.extname(fileName || "").toLowerCase(),
    kind: info?.kind || "file",
    detectedFromContent,
  }
}

export function describeMediaRef(mediaRef) {
  if (Buffer.isBuffer(mediaRef)) return `buffer bytes=${mediaRef.length}`
  if (typeof mediaRef !== "string" || !mediaRef) return `<${typeof mediaRef} media ref>`
  if (/^data:/i.test(mediaRef)) {
    const header = mediaRef.slice(5, mediaRef.indexOf(",") > -1 ? mediaRef.indexOf(",") : 64)
    return `data URI type=${header.split(";", 1)[0] || "unknown"} length=${mediaRef.length}`
  }
  if (/^base64:\/\//i.test(mediaRef)) return `base64 media length=${mediaRef.length - 9}`
  try {
    const url = new URL(mediaRef)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.protocol.slice(0, -1)} URL host=${url.host} file=${safeFileName(url.pathname, "") || "<none>"}`
    }
    if (url.protocol === "file:") return `file URI name=${safeFileName(url.pathname)}`
  } catch {
    // Plain local paths and legacy bare base64 fall through.
  }
  return `local media name=${safeFileName(mediaRef)} length=${mediaRef.length}`
}

export function sanitizeMediaLogText(value) {
  return String(value)
    .replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi, match => {
      const header = match.slice(5, match.indexOf(","))
      return `data:${header},...[length=${match.length}]`
    })
    .replace(/base64:\/\/[A-Za-z0-9+/_=-]+/gi, match => `base64://...[length=${match.length - 9}]`)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, match => {
      try {
        const url = new URL(match)
        if (url.search) url.search = "?..."
        if (url.hash) url.hash = "#..."
        return url.toString()
      } catch {
        return match
      }
    })
    .replace(/\b(encrypt_query_param|upload_param|aes_key|authorization|token)=([^&\s"',}]+)/gi, "$1=...")
}

export async function resolveMediaRef(mediaRef, options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = 15000,
    maxBytes = 100 * 1024 * 1024,
    fileName: suppliedFileName = "",
  } = options

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("Invalid media size limit")

  let buffer
  let fileName = safeFileName(suppliedFileName, "file")
  let declaredMimeType = ""

  if (Buffer.isBuffer(mediaRef)) {
    buffer = mediaRef
  } else if (typeof mediaRef === "string" && mediaRef) {
    if (/^base64:\/\//i.test(mediaRef)) {
      buffer = decodeBase64(mediaRef.slice(9), "base64 media", maxBytes)
    } else if (/^data:/i.test(mediaRef)) {
      const commaIndex = mediaRef.indexOf(",")
      if (commaIndex < 0) throw new Error("Invalid data URI")
      const header = mediaRef.slice(5, commaIndex)
      const parts = header.split(";")
      if (!parts.slice(1).some(part => part.toLowerCase() === "base64")) {
        throw new Error("Only base64 data URIs are supported")
      }
      declaredMimeType = parts[0] || ""
      buffer = decodeBase64(mediaRef.slice(commaIndex + 1), "data URI", maxBytes)
    } else {
      let parsedUrl
      try {
        parsedUrl = new URL(mediaRef)
      } catch {
        parsedUrl = null
      }

      if (parsedUrl?.protocol === "http:" || parsedUrl?.protocol === "https:") {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 15000, 1))
        let response
        try {
          response = await fetchImpl(parsedUrl, {
            signal: controller.signal,
            size: maxBytes,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status} while downloading media`)
          const contentLength = Number(response.headers.get("content-length") || 0)
          if (contentLength > maxBytes) throw new Error(`Media exceeds ${maxBytes} byte limit`)
          buffer = Buffer.from(await response.arrayBuffer())
          declaredMimeType = response.headers.get("content-type") || ""
          if (!suppliedFileName) fileName = fileNameFromResponse(response, parsedUrl)
        } finally {
          clearTimeout(timeout)
        }
      } else {
        let filePath = mediaRef
        if (parsedUrl?.protocol === "file:") filePath = fileURLToPath(parsedUrl)
        try {
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) throw new Error("Media path is not a file")
          if (stat.size > maxBytes) throw new Error(`Media exceeds ${maxBytes} byte limit`)
          buffer = await fs.readFile(filePath)
          if (!suppliedFileName) fileName = safeFileName(filePath)
        } catch (error) {
          if (parsedUrl || error?.code !== "ENOENT") throw error
          buffer = decodeBase64(mediaRef, "bare base64 media", maxBytes)
        }
      }
    }
  } else {
    throw new TypeError(`Unsupported media reference: ${describeMediaRef(mediaRef)}`)
  }

  if (buffer.length > maxBytes) throw new Error(`Media exceeds ${maxBytes} byte limit`)
  const detected = detectMediaFormat(buffer, fileName, declaredMimeType)
  if (detected.extension) {
    const currentFormat = formatFromName(fileName)
    if (!currentFormat || detected.detectedFromContent && currentFormat !== detected.format) {
      fileName = `${path.parse(fileName).name || "file"}${detected.extension}`
    }
  }

  return {
    buffer,
    fileName,
    ...detected,
  }
}
