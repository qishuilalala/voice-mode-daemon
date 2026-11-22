export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

export function decodePcm16Wav(wavBytes: Uint8Array): DecodedWav {
  if (wavBytes.byteLength < 44) {
    throw new Error('Invalid WAV payload: shorter than 44-byte RIFF header');
  }
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const riff =
    String.fromCharCode(wavBytes[0] ?? 0, wavBytes[1] ?? 0, wavBytes[2] ?? 0, wavBytes[3] ?? 0);
  const wave =
    String.fromCharCode(wavBytes[8] ?? 0, wavBytes[9] ?? 0, wavBytes[10] ?? 0, wavBytes[11] ?? 0);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV payload: missing RIFF/WAVE signature');
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= wavBytes.byteLength) {
    const chunkId = String.fromCharCode(
      wavBytes[offset] ?? 0,
      wavBytes[offset + 1] ?? 0,
      wavBytes[offset + 2] ?? 0,
      wavBytes[offset + 3] ?? 0,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (bodyStart + 16 > wavBytes.byteLength) {
        throw new Error('Invalid WAV payload: truncated fmt chunk');
      }
      audioFormat = view.getUint16(bodyStart, true);
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataLength = Math.min(chunkSize, wavBytes.byteLength - bodyStart);
      break;
    }

    const padded = chunkSize + (chunkSize % 2);
    const nextOffset = bodyStart + padded;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `Unsupported WAV format (audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}); 16-bit PCM required`,
    );
  }
  if (channels < 1 || channels > 8 || sampleRate < 4_000 || sampleRate > 192_000) {
    throw new Error(`Invalid WAV stream geometry (channels=${channels}, sampleRate=${sampleRate})`);
  }
  if (dataOffset < 0) {
    throw new Error('Invalid WAV payload: missing data chunk');
  }

  const frameBytes = channels * 2;
  const frameCount = Math.floor(dataLength / frameBytes);
  const mono = new Float32Array(frameCount);
  const dataView = new DataView(wavBytes.buffer, wavBytes.byteOffset + dataOffset, frameCount * frameBytes);

  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const sampleInt = dataView.getInt16((i * channels + ch) * 2, true);
      sum += sampleInt < 0 ? sampleInt / 32768 : sampleInt / 32767;
    }
    mono[i] = sum / channels;
  }

  return { samples: mono, sampleRate, channels };
}

export interface ParsedMultipartForm {
  fields: Record<string, string>;
  file?: {
    fieldName: string;
    fileName: string;
    contentType: string;
    bytes: Uint8Array;
  };
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, fromIndex: number): number {
  if (needle.byteLength === 0) return fromIndex;
  const maxStart = haystack.byteLength - needle.byteLength;
  const first = needle[0];
  outer: for (let i = Math.max(0, fromIndex); i <= maxStart; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_ENCODER = new TextEncoder();
const HEADER_SEP = new Uint8Array([13, 10, 13, 10]); // \r\n\r\n

export function parseMultipartFormData(
  body: Uint8Array,
  contentTypeHeader: string | undefined,
): ParsedMultipartForm {
  if (!contentTypeHeader) {
    throw new Error('Missing Content-Type header on multipart request');
  }
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentTypeHeader);
  const rawBoundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  if (!rawBoundary || rawBoundary.length > 160) {
    throw new Error('Missing or invalid multipart boundary parameter');
  }

  const delimiter = UTF8_ENCODER.encode(`--${rawBoundary}`);
  const fields: Record<string, string> = {};
  let parsedFile: ParsedMultipartForm['file'];

  let pos = indexOfBytes(body, delimiter, 0);
  if (pos === -1) {
    throw new Error('Multipart body does not contain declared boundary');
  }

  while (pos !== -1) {
    const afterDelim = pos + delimiter.byteLength;
    if (afterDelim + 2 <= body.byteLength && body[afterDelim] === 45 && body[afterDelim + 1] === 45) {
      break; // Final `--boundary--`
    }

    let partStart = afterDelim;
    if (body[partStart] === 13 && body[partStart + 1] === 10) {
      partStart += 2;
    } else if (body[partStart] === 10) {
      partStart += 1;
    }

    const headerEnd = indexOfBytes(body, HEADER_SEP, partStart);
    if (headerEnd === -1) break;

    const headerBlock = UTF8_DECODER.decode(body.subarray(partStart, headerEnd));
    const contentStart = headerEnd + HEADER_SEP.byteLength;
    const nextDelim = indexOfBytes(body, delimiter, contentStart);
    if (nextDelim === -1) {
      throw new Error('Truncated multipart part: missing closing boundary');
    }

    let contentEnd = nextDelim;
    if (contentEnd >= 2 && body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    } else if (contentEnd >= 1 && body[contentEnd - 1] === 10) {
      contentEnd -= 1;
    }

    const dispositionLine = headerBlock
      .split(/\r?\n/)
      .find((line) => /^content-disposition:/i.test(line));
    if (dispositionLine) {
      const nameMatch = /\bname="([^"]+)"/i.exec(dispositionLine);
      const fileMatch = /\bfilename="([^"]*)"/i.exec(dispositionLine);
      const fieldName = nameMatch?.[1] ? decodeURIComponentSafe(nameMatch[1]) : '';
      const partBytes = body.subarray(contentStart, contentEnd);

      if (fileMatch && fieldName) {
        const typeLine = headerBlock
          .split(/\r?\n/)
          .find((line) => /^content-type:/i.test(line));
        const partContentType = typeLine
          ? typeLine.slice(typeLine.indexOf(':') + 1).trim()
          : 'application/octet-stream';
        parsedFile = {
          fieldName,
          fileName: decodeURIComponentSafe(fileMatch[1] ?? 'speech.wav'),
          contentType: partContentType,
          bytes: partBytes.slice(),
        };
      } else if (fieldName) {
        fields[fieldName] = UTF8_DECODER.decode(partBytes);
      }
    }

    pos = nextDelim;
  }

  const out: ParsedMultipartForm = { fields };
  if (parsedFile !== undefined) {
    out.file = parsedFile;
  }
  return out;
}

function decodeURIComponentSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
