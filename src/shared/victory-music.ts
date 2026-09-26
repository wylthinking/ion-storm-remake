export const MAX_VICTORY_MUSIC_BYTES = 10 * 1024 * 1024;
export const MAX_VICTORY_MUSIC_DURATION_SECONDS = 15.2;

export interface ParsedVictoryMusic {
  bytes: Uint8Array;
  durationSeconds: number;
  mimeType: "audio/wav" | "audio/mpeg" | "audio/ogg";
  size: number;
}

export function parseVictoryMusicDataUrl(dataUrl: string): ParsedVictoryMusic {
  const match = /^data:(audio\/(?:wav|x-wav|wave|mpeg|mp3|ogg));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error("音乐文件必须是受支持的 Base64 data URL");
  const payload = match[2];
  if (payload.length % 4 !== 0 || /=/.test(payload.slice(0, -2))) throw new Error("音乐文件的 Base64 编码无效");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const expectedSize = (payload.length / 4) * 3 - padding;
  if (expectedSize <= 0) throw new Error("音乐文件无效");
  if (expectedSize > MAX_VICTORY_MUSIC_BYTES) throw new Error("音乐文件不能超过 10MB");

  const bytes = decodeBase64(payload, expectedSize);
  const suppliedMime = match[1].toLowerCase();
  let durationSeconds: number;
  let mimeType: ParsedVictoryMusic["mimeType"];
  if (suppliedMime === "audio/wav" || suppliedMime === "audio/x-wav" || suppliedMime === "audio/wave") {
    durationSeconds = wavDuration(bytes);
    mimeType = "audio/wav";
  } else if (suppliedMime === "audio/mpeg" || suppliedMime === "audio/mp3") {
    durationSeconds = mp3Duration(bytes);
    mimeType = "audio/mpeg";
  } else {
    durationSeconds = oggDuration(bytes);
    mimeType = "audio/ogg";
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("无法读取音乐时长");
  if (durationSeconds > MAX_VICTORY_MUSIC_DURATION_SECONDS) throw new Error("音乐长度不能超过 15 秒");
  return { bytes, durationSeconds, mimeType, size: bytes.byteLength };
}

function decodeBase64(payload: string, expectedSize: number): Uint8Array {
  try {
    if (typeof atob === "function") {
      const binary = atob(payload);
      if (binary.length !== expectedSize) throw new Error("size mismatch");
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    if (typeof Buffer !== "undefined") {
      const decoded = Buffer.from(payload, "base64");
      if (decoded.byteLength !== expectedSize) throw new Error("size mismatch");
      return new Uint8Array(decoded);
    }
  } catch {
    throw new Error("音乐文件的 Base64 编码无效");
  }
  throw new Error("当前运行环境无法解码音乐文件");
}

function wavDuration(bytes: Uint8Array): number {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("WAV 文件头无效");
  }
  const declaredSize = readU32Le(bytes, 4) + 8;
  if (declaredSize > bytes.length || bytes.length - declaredSize > 1) throw new Error("WAV 文件长度无效");
  let offset = 12;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataBytes = 0;
  while (offset + 8 <= declaredSize) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = readU32Le(bytes, offset + 4);
    const bodyOffset = offset + 8;
    const next = bodyOffset + chunkSize + (chunkSize % 2);
    if (bodyOffset + chunkSize > declaredSize || next > bytes.length) throw new Error("WAV 数据块长度无效");
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("WAV fmt 数据块无效");
      const format = readU16Le(bytes, bodyOffset);
      const channels = readU16Le(bytes, bodyOffset + 2);
      sampleRate = readU32Le(bytes, bodyOffset + 4);
      const byteRate = readU32Le(bytes, bodyOffset + 8);
      blockAlign = readU16Le(bytes, bodyOffset + 12);
      const bitsPerSample = readU16Le(bytes, bodyOffset + 14);
      if (![1, 3, 0xfffe].includes(format) || channels < 1 || channels > 32 || sampleRate < 1 || blockAlign < 1 || bitsPerSample < 1) {
        throw new Error("WAV 音频格式不受支持");
      }
      if (byteRate !== sampleRate * blockAlign) throw new Error("WAV 采样参数无效");
    } else if (chunkId === "data") {
      dataBytes += chunkSize;
    }
    offset = next;
  }
  if (!sampleRate || !blockAlign || !dataBytes || dataBytes % blockAlign !== 0) throw new Error("WAV 音频数据无效");
  return dataBytes / blockAlign / sampleRate;
}

function mp3Duration(bytes: Uint8Array): number {
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.length < 10 || (bytes[6] | bytes[7] | bytes[8] | bytes[9]) & 0x80) throw new Error("MP3 ID3 标签无效");
    const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    offset = 10 + tagSize + ((bytes[5] & 0x10) !== 0 ? 10 : 0);
    if (offset > bytes.length) throw new Error("MP3 ID3 标签长度无效");
  }
  let duration = 0;
  let frameCount = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining === 128 && ascii(bytes, offset, 3) === "TAG") {
      offset = bytes.length;
      break;
    }
    if (remaining <= 4 && isAllZero(bytes, offset)) {
      offset = bytes.length;
      break;
    }
    if (remaining < 4 || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) throw new Error("MP3 帧无效");
    const versionBits = (bytes[offset + 1] >> 3) & 0x03;
    const layerBits = (bytes[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      throw new Error("MP3 帧参数无效");
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
    const sampleRates = version === 1 ? [44_100, 48_000, 32_000] : version === 2 ? [22_050, 24_000, 16_000] : [11_025, 12_000, 8_000];
    const bitrates = mp3Bitrates(version, layer);
    const bitrate = bitrates[bitrateIndex - 1] * 1_000;
    const sampleRate = sampleRates[sampleRateIndex];
    const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1_152;
    const frameLength = layer === 1
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate) / sampleRate + padding);
    if (frameLength < 4 || offset + frameLength > bytes.length) throw new Error("MP3 帧长度无效");
    duration += samplesPerFrame / sampleRate;
    frameCount += 1;
    offset += frameLength;
  }
  if (frameCount === 0 || offset !== bytes.length) throw new Error("MP3 音频数据无效");
  return duration;
}

function mp3Bitrates(version: number, layer: number): number[] {
  if (version === 1 && layer === 1) return [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
  if (version === 1 && layer === 2) return [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
  if (version === 1) return [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  if (layer === 1) return [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
  return [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
}

function oggDuration(bytes: Uint8Array): number {
  let offset = 0;
  let maxGranule = -1;
  let firstPacket: number[] = [];
  let firstPacketDone = false;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || ascii(bytes, offset, 4) !== "OggS" || bytes[offset + 4] !== 0) throw new Error("Ogg 页面无效");
    const segmentCount = bytes[offset + 26];
    const tableEnd = offset + 27 + segmentCount;
    if (tableEnd > bytes.length) throw new Error("Ogg 分段表无效");
    let bodySize = 0;
    for (let index = offset + 27; index < tableEnd; index += 1) bodySize += bytes[index];
    const bodyEnd = tableEnd + bodySize;
    if (bodyEnd > bytes.length) throw new Error("Ogg 页面长度无效");
    const granule = readU64Le(bytes, offset + 6);
    if (granule !== -1 && granule > maxGranule) maxGranule = granule;
    if (!firstPacketDone) {
      let bodyOffset = tableEnd;
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const size = bytes[offset + 27 + segment];
        for (let index = 0; index < size && firstPacket.length < 64; index += 1) firstPacket.push(bytes[bodyOffset + index]);
        bodyOffset += size;
        if (size < 255) {
          firstPacketDone = true;
          break;
        }
      }
    }
    offset = bodyEnd;
  }
  const header = Uint8Array.from(firstPacket);
  let sampleRate = 0;
  let preSkip = 0;
  if (ascii(header, 0, 8) === "OpusHead" && header.length >= 19) {
    sampleRate = 48_000;
    preSkip = readU16Le(header, 10);
  } else if (header[0] === 1 && ascii(header, 1, 6) === "vorbis" && header.length >= 16) {
    sampleRate = readU32Le(header, 12);
  } else {
    throw new Error("Ogg 音频编码不受支持");
  }
  if (!sampleRate || maxGranule <= preSkip) throw new Error("Ogg 音频时长无效");
  return (maxGranule - preSkip) / sampleRate;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]);
  return value;
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error("音乐文件被截断");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("音乐文件被截断");
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readU64Le(bytes: Uint8Array, offset: number): number {
  const low = readU32Le(bytes, offset);
  const high = readU32Le(bytes, offset + 4);
  if (low === 0xffff_ffff && high === 0xffff_ffff) return -1;
  const value = low + high * 0x1_0000_0000;
  if (!Number.isSafeInteger(value)) throw new Error("Ogg granule 超出安全范围");
  return value;
}

function isAllZero(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < bytes.length; index += 1) if (bytes[index] !== 0) return false;
  return true;
}
