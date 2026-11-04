// Reads rows out of a DAMAGED PGlite data folder by parsing its heap pages directly (and the values Postgres stored out of line).
// Read-only: it never writes to the folder it reads. Written 2026-11-02 to recover Nya's Story after the database would not open.
//
//   node scripts/salvage-pglite.cjs <damaged pglite folder> <output.json>
//
// It finds `project_items` and `media_assets` rows by their shape (see SCHEMAS below: update them if those tables change) and writes
// every row version it can read. Rows are NOT de-duplicated or checked against what the database still has: a person has to decide
// what to put back. Anything written only to the write-ahead log (the last few minutes before a crash) cannot be read this way.
// Always work on a COPY of the damaged folder, and never open a folder while a back end is running on it.
// Reads rows out of a damaged PGlite data folder by parsing its heap pages directly. Read-only: it never writes to the folder it reads.
const fs = require('fs'), path = require('path');

const PAGE = 8192;
const align = (p, a) => (p + a - 1) & ~(a - 1);

// ---- jsonb (binary) ----------------------------------------------------------------------------------------
function numericOf(b, p) {
  // a Numeric varlena: 1-byte or 4-byte header, then n_header (u16) and digits
  let q = p, len;
  if (b[q] & 1) { len = b[q] >> 1; q += 1; } else { len = b.readUInt32LE(q) >> 2; q += 4; }
  const end = p + len;
  const nh = b.readUInt16LE(q); q += 2;
  let sign = 1, dscale, weight;
  if ((nh & 0xC000) === 0x8000) { // short
    sign = nh & 0x2000 ? -1 : 1; dscale = (nh & 0x1F80) >> 7; weight = nh & 0x40 ? (nh | ~0x7F) : (nh & 0x7F);
  } else if ((nh & 0xC000) === 0xC000) return NaN;
  else { sign = (nh & 0xC000) === 0x4000 ? -1 : 1; dscale = nh & 0x3FFF; weight = b.readInt16LE(q); q += 2; }
  let v = 0, i = 0;
  while (q + 1 < end + 0) { if (q + 2 > end) break; v += b.readInt16LE(q) * Math.pow(10000, weight - i); q += 2; i++; }
  return sign * Number(v.toFixed(dscale));
}
function jsonbContainer(b, start) {
  const header = b.readUInt32LE(start);
  const count = header & 0x0FFFFFFF, isObj = !!(header & 0x20000000), isScalar = !!(header & 0x10000000);
  const n = isObj ? count * 2 : count;
  const ents = []; for (let i = 0; i < n; i++) ents.push(b.readUInt32LE(start + 4 + 4 * i));
  const base = start + 4 + 4 * n;
  const offOf = (i) => { let o = 0; for (let k = i - 1; k >= 0; k--) { o += ents[k] & 0x0FFFFFFF; if (ents[k] & 0x80000000) break; } return o; };
  const lenOf = (i) => { const o = offOf(i); return ents[i] & 0x80000000 ? (ents[i] & 0x0FFFFFFF) - o : (ents[i] & 0x0FFFFFFF); };
  const val = (i) => {
    const t = ents[i] & 0x70000000, o = offOf(i), l = lenOf(i);
    if (t === 0x00000000) return b.toString('utf8', base + o, base + o + l);
    if (t === 0x10000000) return numericOf(b, base + align(o, 4));
    if (t === 0x20000000) return false;
    if (t === 0x30000000) return true;
    if (t === 0x40000000) return null;
    return jsonbContainer(b, base + align(o, 4));
  };
  if (isObj) { const out = {}; for (let i = 0; i < count; i++) out[val(i)] = val(count + i); return out; }
  const arr = []; for (let i = 0; i < count; i++) arr.push(val(i));
  return isScalar ? arr[0] : arr;
}

// ---- pglz (for values Postgres squeezed) -------------------------------------------------------------------
function pglz(src, rawSize) {
  const out = Buffer.alloc(rawSize); let sp = 0, dp = 0;
  while (sp < src.length && dp < rawSize) {
    let ctrl = src[sp++];
    for (let k = 0; k < 8 && sp < src.length && dp < rawSize; k++, ctrl >>= 1) {
      if (ctrl & 1) {
        let len = (src[sp] & 0x0f) + 3, off = ((src[sp] & 0xf0) << 4) | src[sp + 1]; sp += 2;
        if (len === 18) len += src[sp++];
        for (let j = 0; j < len && dp < rawSize; j++) { out[dp] = out[dp - off]; dp++; }
      } else out[dp++] = src[sp++];
    }
  }
  return out.subarray(0, dp);
}

// ---- tuple columns -----------------------------------------------------------------------------------------
const SCHEMAS = {
  project_items: ['uuid', 'uuid', 'uuid', 'text', 'text', 'int4', 'text', 'text', 'text', 'text', 'text', 'jsonb', 'jsonb', 'jsonb', 'text', 'text', 'uuid', 'timestamptz', 'timestamptz'],
  media_assets: ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'array', 'jsonb', 'uuid', 'uuid', 'timestamptz', 'uuid'],
};
const uuidStr = (b) => { const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const PG_EPOCH = Date.UTC(2000, 0, 1);

function readVarlena(b, pos) {
  if (b[pos] === 0) pos = align(pos, 4);
  const h = b[pos];
  if ((h & 1) === 1) {
    if (h === 1) { return { next: pos + 18, data: null, toast: { rawsize: b.readInt32LE(pos + 2), extsize: b.readInt32LE(pos + 6) & 0x3FFFFFFF, method: b.readUInt32LE(pos + 6) >>> 30, valueid: b.readUInt32LE(pos + 10) } }; }
    const len = h >> 1; return { next: pos + len, data: b.subarray(pos + 1, pos + len) };
  }
  const word = b.readUInt32LE(pos); const len = word >> 2;
  if ((h & 3) === 0) return { next: pos + len, data: b.subarray(pos + 4, pos + len) };
  if ((h & 3) === 2) { const raw = b.readUInt32LE(pos + 4) & 0x3FFFFFFF; return { next: pos + len, data: pglz(b.subarray(pos + 8, pos + len), raw) }; }
  throw new Error('odd varlena');
}

function decodeTuple(buf, schema) {
  const infomask2 = buf.readUInt16LE(18), infomask = buf.readUInt16LE(20), hoff = buf[22];
  const natts = infomask2 & 0x7FF;
  if (natts > schema.length || natts < schema.length - 3) throw new Error('natts');
  const hasNull = !!(infomask & 1);
  const isNull = (i) => hasNull && !(buf[23 + (i >> 3)] & (1 << (i & 7)));
  let pos = hoff; const row = {};
  const names = Object.keys(row);
  for (let i = 0; i < natts; i++) {
    if (isNull(i)) { row[i] = null; continue; }
    const t = schema[i];
    if (t === 'uuid') { row[i] = uuidStr(buf.subarray(pos, pos + 16)); pos += 16; }
    else if (t === 'int4') { pos = align(pos, 4); row[i] = buf.readInt32LE(pos); pos += 4; }
    else if (t === 'timestamptz') { pos = align(pos, 8); row[i] = new Date(PG_EPOCH + Number(buf.readBigInt64LE(pos)) / 1000); pos += 8; }
    else {
      const v = readVarlena(buf, pos); pos = v.next;
      if (v.toast) row[i] = { __toast: v.toast, as: t };
      else if (t === 'text') row[i] = v.data.toString('utf8');
      else if (t === 'jsonb') { try { row[i] = jsonbContainer(v.data, 0); } catch { row[i] = '(unreadable)'; } }
      else row[i] = null;
    }
  }
  return { row, xmin: buf.readUInt32LE(0), xmax: buf.readUInt32LE(4), infomask };
}

function* tuplesOf(file) {
  const b = fs.readFileSync(file);
  for (let p = 0; p + PAGE <= b.length; p += PAGE) {
    const lower = b.readUInt16LE(p + 12), upper = b.readUInt16LE(p + 14);
    if (lower < 24 || lower > PAGE || upper > PAGE || upper < lower) continue;
    for (let o = 24; o + 4 <= lower; o += 4) {
      const lp = b.readUInt32LE(p + o); const off = lp & 0x7FFF, flags = (lp >> 15) & 3, len = lp >>> 17;
      if (flags !== 1 || len < 24 || off + len > PAGE) continue;
      yield b.subarray(p + off, p + off + len);
    }
  }
}


// ---- values stored out of line (Postgres "TOAST"): chunks live in another file of the same folder -------------
function loadToast(root) {
  const chunks = new Map(); // valueid -> Map(seq -> Buffer)
  const dir = path.join(root, 'base');
  for (const db of fs.readdirSync(dir)) {
    const d = path.join(dir, db); if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/^\d+$/.test(f)) continue;
      const file = path.join(d, f); if (fs.statSync(file).size < PAGE) continue;
      for (const t of tuplesOf(file)) {
        try {
          const infomask2 = t.readUInt16LE(18), hoff = t[22];
          if ((infomask2 & 0x7FF) !== 3) continue;
          let pos = align(hoff, 4); const id = t.readUInt32LE(pos); pos += 4;
          const seq = t.readInt32LE(pos); pos += 4;
          if (seq < 0 || seq > 5000) continue;
          const v = readVarlena(t, pos); if (v.toast || !v.data || v.data.length > 2100) continue;
          const m = chunks.get(id) ?? new Map(); m.set(seq, Buffer.from(v.data)); chunks.set(id, m);
        } catch { /* not a chunk */ }
      }
    }
  }
  return chunks;
}
function resolveToast(val, chunks) {
  if (!val || typeof val !== 'object' || !val.__toast) return val;
  const { rawsize, extsize, valueid } = val.__toast; const m = chunks.get(valueid);
  if (!m) return val.as === 'text' ? '(stored elsewhere and not found)' : '(unreadable)';
  const parts = []; for (let s = 0; m.has(s); s++) parts.push(m.get(s));
  let data = Buffer.concat(parts);
  if (data.length !== extsize) return '(stored elsewhere, incomplete)';
  if (extsize < rawsize - 4) data = pglz(data.subarray(4), rawsize - 4 - 0).length ? pglz(data.subarray(4), rawsize - 4) : data;
  if (val.as === 'text') return data.toString('utf8');
  try { return jsonbContainer(data, 0); } catch { return '(unreadable)'; }
}
function salvage(root) {
  const out = { project_items: [], media_assets: [] };
  const toastChunks = loadToast(root);
  const dir = path.join(root, 'base');
  for (const db of fs.readdirSync(dir)) {
    const d = path.join(dir, db); if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/^\d+$/.test(f)) continue;
      const file = path.join(d, f); if (fs.statSync(file).size < PAGE) continue;
      for (const t of tuplesOf(file)) {
        for (const [name, schema] of Object.entries(SCHEMAS)) {
          try {
            const { row, xmin, xmax, infomask } = decodeTuple(t, schema);
            if (name === 'project_items' && (['shot', 'ad_unit'].includes(row[3])) && /^[0-9a-f-]{36}$/.test(row[0] ?? '') && typeof row[6] === 'string' && ['draft', 'ready', 'generating', 'review', 'approved', 'rejected'].includes(row[14])) {
              out.project_items.push({ file: f, xmin, xmax, id: row[0], projectId: row[2], kind: row[3], group: row[4], position: row[5], title: row[6], prompt: row[7], notes: row[8], modelId: row[9], mode: row[10], settings: row[11], media: row[12], meta: row[13], status: row[14], lastError: row[15], approvedAssetId: row[16], createdAt: row[17], updatedAt: row[18] });
            }
            if (name === 'media_assets' && ['photo', 'video'].includes(row[2]) && /^[0-9a-f-]{36}$/.test(row[0] ?? '') && typeof row[4] === 'string' && row[7] && typeof row[7] === 'object') {
              out.media_assets.push({ file: f, xmin, xmax, infomask, id: row[0], type: row[2], title: row[3], url: row[4], thumbUrl: row[5], metadata: row[7], workflowId: row[8], runId: row[9], createdAt: row[10], workspaceId: row[11] });
            }
          } catch { /* not this table */ }
        }
      }
    }
  }
  for (const r of out.project_items) for (const k of ['prompt', 'notes', 'modelId', 'mode', 'settings', 'media', 'meta', 'title', 'group']) r[k] = resolveToast(r[k], toastChunks);
  for (const r of out.media_assets) for (const k of ['title', 'url', 'metadata']) r[k] = resolveToast(r[k], toastChunks);
  return out;
}

module.exports = { salvage };
if (require.main === module) {
  const r = salvage(process.argv[2]);
  fs.writeFileSync(process.argv[3], JSON.stringify(r, null, 1));
  console.log(JSON.stringify({ project_items: r.project_items.length, media_assets: r.media_assets.length, itemFiles: [...new Set(r.project_items.map((x) => x.file))], mediaFiles: [...new Set(r.media_assets.map((x) => x.file))] }));
}
