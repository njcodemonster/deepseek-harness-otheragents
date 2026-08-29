/**
 * Wire-level tests for the cloud-direct protobuf + Connect framing helpers.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeVarint,
  encodeMessage,
  encodeString,
  encodeVarint,
  encodeVarintField,
  frameConnectStream,
  iterFields,
  parseConnectFrames,
} from '../src/cloud-direct/wire.ts'

describe('proto wire encoding', () => {
  it('round-trips varints', () => {
    expect(encodeVarint(0).toString('hex')).toBe('00')
    expect(encodeVarint(1).toString('hex')).toBe('01')
    expect(encodeVarint(127).toString('hex')).toBe('7f')
    expect(encodeVarint(128).toString('hex')).toBe('8001')
    const [decoded, consumed] = decodeVarint(encodeVarint(300), 0)
    expect(decoded).toBe(300n)
    expect(consumed).toBe(2)
  })

  it('rejects negative varints', () => {
    expect(() => encodeVarint(-1)).toThrow(/negative/)
  })

  it('encodes strings and messages', () => {
    const s = encodeString(3, 'hello')
    const fields = [...iterFields(s)]
    expect(fields).toHaveLength(1)
    expect(fields[0]?.num).toBe(3)
    expect(fields[0]?.wire).toBe(2)
    expect((fields[0]?.value as Buffer).toString()).toBe('hello')

    const inner = encodeVarintField(1, 7)
    const m = encodeMessage(2, inner)
    const [outer] = [...iterFields(m)]
    expect(outer?.num).toBe(2)
    const innerFields = [...iterFields(outer?.value as Buffer)]
    expect(innerFields[0]?.num).toBe(1)
    expect(innerFields[0]?.value).toBe(7n)
  })
})

describe('connect framing', () => {
  it('frames and parses a gzip payload', () => {
    const body = encodeString(3, 'delta text')
    const framed = frameConnectStream(body, true)
    // header: flags 0x01 + length
    expect(framed[0]).toBe(0x01)
    const [frame] = parseConnectFrames(framed)
    expect(frame?.eos).toBe(false)
    expect(frame?.payload.equals(body)).toBe(true)
  })

  it('parses an eos trailer frame', () => {
    const trailer = Buffer.from([0x02, 0, 0, 0, 0])
    const [frame] = parseConnectFrames(trailer)
    expect(frame?.eos).toBe(true)
  })

  it('stops cleanly on a truncated frame', () => {
    const framed = frameConnectStream(encodeString(3, 'x'), true)
    const truncated = framed.subarray(0, framed.length - 2)
    const frames = parseConnectFrames(truncated)
    expect(frames).toHaveLength(0)
  })
})
