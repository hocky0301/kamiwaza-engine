// ZIP生成の検証: CRC32はNode組込みのzlib.crc32と一致・構造はEOCD/ヘッダのマジックで確認
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildZip, crc32 } from "../zip";

const enc = new TextEncoder();

describe("crc32", () => {
  it("zlib.crc32と一致する", () => {
    for (const s of ["", "hello", "カミワザ", "a".repeat(10000)]) {
      const d = enc.encode(s);
      expect(crc32(d)).toBe(zlibCrc32(d) >>> 0);
    }
  });
});

describe("buildZip", () => {
  const files = [
    { name: "README.txt", data: enc.encode("hello") },
    { name: "データ/records.json", data: enc.encode('{"a":1}') },
  ];
  const zip = buildZip(files, new Date(2026, 7, 16, 10, 30, 0));
  const u32at = (o: number) =>
    (zip[o]! | (zip[o + 1]! << 8) | (zip[o + 2]! << 16) | (zip[o + 3]! << 24)) >>> 0;
  it("local headerのマジックで始まる", () => {
    expect(u32at(0)).toBe(0x04034b50);
  });
  it("EOCDが末尾にあり、件数=2", () => {
    const eocd = zip.length - 22;
    expect(u32at(eocd)).toBe(0x06054b50);
    expect(zip[eocd + 10]! | (zip[eocd + 11]! << 8)).toBe(2);
  });
  it("決定論: 同時刻なら同一バイト列", () => {
    const z2 = buildZip(files, new Date(2026, 7, 16, 10, 30, 0));
    expect(Buffer.from(z2).equals(Buffer.from(zip))).toBe(true);
  });
  it("UTF-8フラグが立っている(bit11)", () => {
    const flags = zip[6]! | (zip[7]! << 8);
    expect(flags & 0x0800).toBe(0x0800);
  });
});
