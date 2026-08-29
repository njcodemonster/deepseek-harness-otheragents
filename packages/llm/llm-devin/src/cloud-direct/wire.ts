/**
 * Manual protobuf + Connect-RPC streaming envelope helpers.
 *
 * Ported from the MIT-licensed `pi-devin-auth` package (can1357/oh-my-pi),
 * which itself derives the cloud-direct layer from opencode-windsurf-auth.
 * The wire format matches Cognition's `exa.api_server_pb.ApiServerService`:
 *
 * Connect-RPC streaming wire format (HTTPS POST body):
 *   ┌─────────┬──────────────┬───────────┐
 *   │ flags 1 │ length 4B BE │  payload  │
 *   └─────────┴──────────────┴───────────┘
 *   flags bit 0x01 = payload is gzip-compressed
 *   flags bit 0x02 = end-of-stream (trailer frame — JSON {error} or empty {})
 *
 * @module dsh-llm-devin/cloud-direct/wire
 */

import * as zlib from 'node:zlib'

// ----------------------------------------------------------------------------
// Proto wire encode
// ----------------------------------------------------------------------------

export function encodeVarint(value: number | bigint): Buffer {
  const v0 = BigInt(value)
  if (v0 < 0n) {
    throw new RangeError(`encodeVarint: negative input not supported (got ${value})`)
  }
  const bytes: number[] = []
  let v = v0
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

export function encodeTag(fieldNum: number, wire: number): Buffer {
  return encodeVarint((fieldNum << 3) | wire)
}

export function encodeString(fieldNum: number, s: string): Buffer {
  const buf = Buffer.from(s, 'utf8')
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf])
}

export function encodeMessage(fieldNum: number, body: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(body.length), body])
}

export function encodeVarintField(fieldNum: number, v: number | bigint): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(v)])
}

export function encodeFixed64Field(fieldNum: number, v: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(v, 0)
  return Buffer.concat([encodeTag(fieldNum, 1), b])
}

export function encodeTimestampBody(): Buffer {
  const now = Date.now()
  const seconds = Math.floor(now / 1000)
  const nanos = (now % 1000) * 1_000_000
  return Buffer.concat([
    encodeVarintField(1, seconds),
    nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0),
  ])
}

// ----------------------------------------------------------------------------
// Proto wire decode
// ----------------------------------------------------------------------------

export function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
  let res = 0n
  let shift = 0n
  let i = offset
  while (i < buf.length) {
    const b = buf[i]
    if (b === undefined) throw new Error('truncated varint')
    i++
    res |= BigInt(b & 0x7f) << shift
    if (!(b & 0x80)) return [res, i]
    shift += 7n
  }
  throw new Error('truncated varint')
}

export interface ProtoField {
  num: number
  wire: number
  /** varint → bigint, fixed → 8/4 byte Buffer, length-delim → payload Buffer. */
  value: bigint | Buffer
}

export function* iterFields(buf: Buffer): Generator<ProtoField> {
  let i = 0
  while (i < buf.length) {
    const [tagBig, ai] = decodeVarint(buf, i)
    i = ai
    const tag = Number(tagBig)
    const num = tag >> 3
    const wire = tag & 0x7
    if (wire === 0) {
      const [v, bi] = decodeVarint(buf, i)
      i = bi
      yield { num, wire, value: v }
    } else if (wire === 1) {
      if (i + 8 > buf.length) return
      yield { num, wire, value: buf.slice(i, i + 8) }
      i += 8
    } else if (wire === 2) {
      const [n, ci] = decodeVarint(buf, i)
      i = ci
      const len = Number(n)
      if (len < 0 || i + len > buf.length) return
      yield { num, wire, value: buf.slice(i, i + len) }
      i += len
    } else if (wire === 5) {
      if (i + 4 > buf.length) return
      yield { num, wire, value: buf.slice(i, i + 4) }
      i += 4
    } else {
      // Wire types 3/4 (groups) and unknown types: bail rather than misalign.
      return
    }
  }
}

// ----------------------------------------------------------------------------
// Connect-streaming envelope
// ----------------------------------------------------------------------------

/** Wrap `body` in a Connect-streaming envelope; gzip when `compress` is true. */
export function frameConnectStream(body: Buffer, compress = true): Buffer {
  let payload = body
  let flags = 0
  if (compress) {
    payload = zlib.gzipSync(body)
    flags |= 0x01
  }
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

export interface ConnectFrame {
  flags: number
  /** Decompressed payload (gzip handled here if flags & 0x01). */
  payload: Buffer
  /** Frame is the trailer (end-of-stream). */
  eos: boolean
}

/** Parse every Connect-streaming frame out of a response body. */
export function parseConnectFrames(buf: Buffer): ConnectFrame[] {
  const out: ConnectFrame[] = []
  let i = 0
  while (i + 5 <= buf.length) {
    const flags = buf[i]
    if (flags === undefined) break
    const len = buf.readUInt32BE(i + 1)
    if (i + 5 + len > buf.length) break
    let payload = buf.slice(i + 5, i + 5 + len)
    if (flags & 0x01) {
      payload = zlib.gunzipSync(payload)
    }
    out.push({ flags, payload, eos: (flags & 0x02) !== 0 })
    i += 5 + len
  }
  return out
}

/**
 * A fetch-body view over a Buffer. Node's generic `Buffer<ArrayBufferLike>`
 * is not assignable to the DOM `BodyInit` union under strict lib settings;
 * a Uint8Array view over the same bytes is a valid body at runtime.
 */
export function bodyOf(buf: Buffer): BodyInit {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) as BodyInit
}
