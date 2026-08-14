// 依存ゼロのZIP生成(無圧縮STORE)。エクスポートの中身を「1ファイルのJSON」ではなく
// 「READMEつきのZIP一式」にするためのもの。ブースで配る・あとで集めて改善に使う、が目的なので
// 圧縮率より (a)追加依存ゼロ (b)中身が自己説明的 を優先する。
// フォーマット: PKZIP APPNOTE 4.4.3 の最小サブセット(local header + central directory + EOCD)。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

/** 無圧縮ZIPを組み立てて返す(ファイル名はUTF-8フラグ付き) */
export function buildZip(files: ZipFile[], now: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    // flags bit11 = ファイル名がUTF-8
    const common = cat(
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8
      u16(0), // method: STORE
      u16(time),
      u16(date),
      u32(crc),
      u32(f.data.length),
      u32(f.data.length),
      u16(name.length),
      u16(0), // extra len
    );
    const local = cat(u32(0x04034b50), common, name, f.data);
    central.push(
      cat(
        u32(0x02014b50),
        u16(20), // version made by
        common,
        u16(0), // comment len
        u16(0), // disk start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        name,
      ),
    );
    chunks.push(local);
    offset += local.length;
  }

  const centralBlob = cat(...central);
  const eocd = cat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBlob.length),
    u32(offset),
    u16(0),
  );
  return cat(...chunks, centralBlob, eocd);
}
