const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const multer = require("multer");
const QRCode = require("qrcode");
const XLSX = require("xlsx");

// NOTE: newer nanoid versions are ESM-only and will throw ERR_REQUIRE_ESM
// when required from CommonJS. To keep this project runnable with `node server.js`
// we generate short IDs using Node's built-in crypto instead.
function randomHex(len = 8) {
  // hex length is 2 chars per byte
  const bytes = Math.ceil(len / 2);
  return crypto.randomBytes(bytes).toString("hex").slice(0, len);
}

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "db.json");
const IMAGE_DIR = path.join(PUBLIC_DIR, "assets", "images");

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

/** -----------------------------
 *  JSON DB helpers (atomic write)
 * ------------------------------*/
let writeQueue = Promise.resolve();

async function readDb() {
  const raw = await fsp.readFile(DB_PATH, "utf-8");
  return JSON.parse(raw);
}
async function writeDb(db) {
  // serialize writes to avoid corruption
  writeQueue = writeQueue.then(async () => {
    const tmp = DB_PATH + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
    await fsp.rename(tmp, DB_PATH);
  });
  return writeQueue;
}

/** -----------------------------
 *  Simple token (HMAC)
 *  payload: {u, r, n, exp}
 * ------------------------------*/
const SECRET = process.env.MEM_SECRET || "UPH_MEM_SYSTEM_DEV_SECRET_CHANGE_ME";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}
function sign(data) {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}
function makeToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = sign(body);
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sign(body) !== sig) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")); }
  catch { return null; }
  if (!payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

function authRequired(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, message: "Unauthorized" });
  req.user = payload;
  next();
}
function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user?.r !== "admin") {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }
    next();
  });
}

/** -----------------------------
 *  Upload (images)
 * ------------------------------*/
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try { await fsp.mkdir(IMAGE_DIR, { recursive: true }); } catch {}
    cb(null, IMAGE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
    const safe = (req.params.id || randomHex(8)).replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${safe}${ext}`);
  }
});
const upload = multer({ storage });

// Upload (excel import) - keep in memory
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// Common column names used in Excel (Thai/English) -> internal Thai columns
const COL = {
  CODE: "รหัสเครื่องมือห้องปฏิบัติการ",
  NAME: "ชื่อ",
  MODEL: "รุ่น",
  SN: "หมายเลขเครื่อง",
  STATUS: "สถานะ",
  MAINT: "สถานะแจ้งซ่อม",
  LOC: "สถานที่ใช้งาน (ปัจจุบัน)",
  IMAGE: "รูปภาพครุภัณฑ์"
};

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null) {
      const v = obj[k];
      if (typeof v === "string") {
        const s = v.trim();
        if (s) return s;
      } else if (v !== "") {
        return String(v);
      }
    }
  }
  return "";
}

function normalizeImportedRow(row, db) {
  // Keep all original columns but ensure required ones exist
  const out = { ...row };

  const code = pickFirst(row, [COL.CODE, "รหัสครุภัณฑ์", "รหัส", "code", "Code", "CODE"]);
  if (!code) return null;
  out[COL.CODE] = code;

  // Optional standard fields
  const name = pickFirst(row, [COL.NAME, "name", "Name"]);
  if (name) out[COL.NAME] = name;

  const model = pickFirst(row, [COL.MODEL, "model", "Model"]);
  if (model) out[COL.MODEL] = model;

  const sn = pickFirst(row, [COL.SN, "SN", "S/N", "Serial", "serial", "หมายเลขเครื่อง/Serial"]);
  if (sn) out[COL.SN] = sn;

  // Defaults
  if (!out[COL.MAINT]) out[COL.MAINT] = (db.maintenanceStatusChoices || [])[0] || "ยังไม่เคยแจ้งซ่อม";
  if (!out[COL.IMAGE]) out[COL.IMAGE] = "";

  // Ensure id
  if (!out.id) out.id = "A-" + randomHex(6).toUpperCase();

  return out;
}

/** -----------------------------
 *  Auto asset-code generator
 *  - EQ: LAB-AS-EQ-A001, A002...
 *  - GN: LAB-AS-GN-A001, A002...
 *  (Always computed from full db.assets, independent of search/filter)
 * ------------------------------*/
function pad3(n){
  return String(Math.max(0, Number(n)||0)).padStart(3, "0");
}
function escapeRegex(s){
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function nextAssetCode(db, kind){
  const k = String(kind||"EQ").toUpperCase();
  const prefix = (k === "GN") ? "LAB-AS-GN-A" : "LAB-AS-EQ-A";
  const re = new RegExp("^" + escapeRegex(prefix) + "(\\d+)$", "i");
  let maxNum = 0;
  for (const a of (db.assets || [])) {
    const code = String(a?.[COL.CODE] || "").trim();
    const m = re.exec(code);
    if (!m) continue;
    const num = Number(m[1]);
    if (Number.isFinite(num) && num > maxNum) maxNum = num;
  }
  return prefix + pad3(maxNum + 1);
}

/** -----------------------------
 *  API
 * ------------------------------*/
app.get("/api/meta", async (req, res) => {
  const db = await readDb();
  res.json({ ok: true, meta: db.meta, maintenanceStatusChoices: db.maintenanceStatusChoices || [] });
});

/** -----------------------------
 *  Excel import / export (Admin)
 *  - Import: upload .xlsx/.xls and convert rows into db.assets
 *    mode = replace | merge (merge by asset code)
 *  - Export: generate .xlsx from current db.assets
 * ------------------------------*/

function normalizeImportedRow(rawRow, db) {
  const row = { ...rawRow };

  // map common headers to Thai headers used by the app
  const code = pickFirst(row, [
    COL.CODE, "รหัสครุภัณฑ์", "รหัสเครื่องมือ", "code", "Code", "CODE"
  ]);
  if (!code) return null;
  row[COL.CODE] = row[COL.CODE] || code;

  const name = pickFirst(row, [COL.NAME, "ชื่อครุภัณฑ์", "name", "Name"]);
  if (name) row[COL.NAME] = row[COL.NAME] || name;

  const model = pickFirst(row, [COL.MODEL, "Model", "model"]);
  if (model) row[COL.MODEL] = row[COL.MODEL] || model;

  const sn = pickFirst(row, [COL.SN, "S/N", "SN", "Serial", "serial", "หมายเลขเครื่อง/Serial"]);
  if (sn) row[COL.SN] = row[COL.SN] || sn;

  const status = pickFirst(row, [COL.STATUS, "Status", "status"]);
  if (status) row[COL.STATUS] = row[COL.STATUS] || status;

  const loc = pickFirst(row, [COL.LOC, "สถานที่ใช้งาน", "Location", "location"]);
  if (loc) row[COL.LOC] = row[COL.LOC] || loc;

  // Defaults
  if (!row[COL.MAINT]) row[COL.MAINT] = (db.maintenanceStatusChoices || [])[0] || "ยังไม่เคยแจ้งซ่อม";
  if (!row[COL.IMAGE]) row[COL.IMAGE] = "";

  // numeric cleanup
  if (Object.prototype.hasOwnProperty.call(row, "ต้นทุนต่อหน่วย")) {
    const v = row["ต้นทุนต่อหน่วย"];
    if (typeof v === "string") {
      const n = Number(v.replace(/,/g, "").trim());
      if (Number.isFinite(n)) row["ต้นทุนต่อหน่วย"] = n;
    }
  }

  // ensure id
  if (!row.id) row.id = "A-" + randomHex(6).toUpperCase();

  return row;
}

app.post("/api/import/excel", adminRequired, excelUpload.single("excel"), async (req, res) => {
  const mode = (req.body?.mode || "merge").toString();
  const file = req.file;
  if (!file?.buffer) return res.status(400).json({ ok: false, message: "ไม่พบไฟล์ Excel" });

  let wb;
  try {
    wb = XLSX.read(file.buffer, { type: "buffer" });
  } catch (e) {
    return res.status(400).json({ ok: false, message: "อ่านไฟล์ Excel ไม่ได้" });
  }

  const sheetName = (req.body?.sheet || wb.SheetNames?.[0] || "").toString();
  const ws = wb.Sheets[sheetName];
  if (!ws) return res.status(400).json({ ok: false, message: "ไม่พบชีตในไฟล์ Excel" });

  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
  const db = await readDb();

  let skipped = 0;
  const imported = [];
  for (const r of rawRows) {
    // skip fully empty rows
    const hasAny = Object.values(r || {}).some(v => String(v ?? "").trim() !== "");
    if (!hasAny) continue;

    const norm = normalizeImportedRow(r, db);
    if (!norm) { skipped++; continue; }
    imported.push(norm);
  }

  // dedupe by code (keep last)
  const mapImport = new Map();
  for (const a of imported) {
    const code = String(a[COL.CODE] || "").trim();
    if (!code) continue;
    mapImport.set(code, a);
  }
  const importedUnique = Array.from(mapImport.values());

  let created = 0;
  let updated = 0;

  if (mode === "replace") {
    db.assets = importedUnique;
    created = importedUnique.length;
  } else {
    // merge by code
    const existing = db.assets || [];
    const mapExisting = new Map(existing.map(a => [String(a[COL.CODE] || "").trim(), a]));

    for (const inc of importedUnique) {
      const code = String(inc[COL.CODE] || "").trim();
      if (!code) continue;

      if (mapExisting.has(code)) {
        const cur = mapExisting.get(code);
        const merged = { ...cur, ...inc, id: cur.id };
        // preserve image if incoming empty
        if (!inc[COL.IMAGE]) merged[COL.IMAGE] = cur[COL.IMAGE] || "";
        mapExisting.set(code, merged);
        updated++;
      } else {
        mapExisting.set(code, inc);
        created++;
      }
    }

    db.assets = Array.from(mapExisting.values());
  }

  await writeDb(db);
  res.json({ ok: true, mode, imported: importedUnique.length, created, updated, skipped, sheet: sheetName });
});

app.get("/api/export/excel", adminRequired, async (req, res) => {
  const db = await readDb();
  const assets = db.assets || [];

  // Export without large internal-only fields if any
  const clean = assets.map(a => {
    const { id, ...rest } = a;
    return { id, ...rest };
  });

  const ws = XLSX.utils.json_to_sheet(clean);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Assets");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=UPH_MEM_assets.xlsx");
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const db = await readDb();
  const user = (db.users || []).find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ ok: false, message: "ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง" });

  const payload = {
    u: user.username,
    r: user.role,
    n: user.displayName,
    exp: Date.now() + (1000 * 60 * 60 * 8) // 8 hours
  };
  const token = makeToken(payload);
  res.json({ ok: true, token, user: { username: user.username, displayName: user.displayName, role: user.role } });
});

app.get("/api/me", authRequired, async (req, res) => {
  res.json({ ok: true, user: { username: req.user.u, displayName: req.user.n, role: req.user.r, exp: req.user.exp } });
});

// คืนค่ารหัสถัดไปสำหรับการเพิ่มรายการใหม่ (คำนวณจากข้อมูลทั้งหมดใน db.json)
// ใช้: GET /api/next-code?kind=EQ|GN (Admin only)
app.get("/api/next-code", adminRequired, async (req, res) => {
  const kind = String(req.query.kind || "EQ").toUpperCase();
  if (!["EQ","GN"].includes(kind)) {
    return res.status(400).json({ ok: false, message: "kind ต้องเป็น EQ หรือ GN" });
  }
  const db = await readDb();
  const next = nextAssetCode(db, kind);
  res.json({ ok: true, kind, next });
});

app.get("/api/assets", authRequired, async (req, res) => {
  const db = await readDb();
  let assets = db.assets || [];

  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (q) {
    assets = assets.filter(a => {
      const code = (a["รหัสเครื่องมือห้องปฏิบัติการ"] || "").toString().toLowerCase();
      const name = (a["ชื่อ"] || "").toString().toLowerCase();
      const sn = (a["หมายเลขเครื่อง"] || "").toString().toLowerCase();
      const loc = (a["สถานที่ใช้งาน (ปัจจุบัน)"] || "").toString().toLowerCase();
      return code.includes(q) || name.includes(q) || sn.includes(q) || loc.includes(q);
    });
  }

  res.json({ ok: true, assets });
});

app.get("/api/assets/by-code/:code", async (req, res) => {
  const code = (req.params.code || "").toString();
  const db = await readDb();
  const asset = (db.assets || []).find(a => (a["รหัสเครื่องมือห้องปฏิบัติการ"] || "").toString() === code);
  if (!asset) return res.status(404).json({ ok: false, message: "ไม่พบครุภัณฑ์" });
  res.json({ ok: true, asset });
});

app.post("/api/assets", adminRequired, async (req, res) => {
  const db = await readDb();
  const asset = req.body || {};

  // Ensure required code
  const code = (asset["รหัสเครื่องมือห้องปฏิบัติการ"] || "").toString().trim();
  if (!code) return res.status(400).json({ ok: false, message: "ต้องมีรหัสเครื่องมือห้องปฏิบัติการ" });

  // Prevent duplicates
  const exists = (db.assets || []).some(a => (a["รหัสเครื่องมือห้องปฏิบัติการ"] || "").toString() === code);
  if (exists) return res.status(409).json({ ok: false, message: "รหัสนี้มีอยู่แล้ว" });

  asset.id = "A-" + randomHex(6).toUpperCase();
  if (!asset["สถานะแจ้งซ่อม"]) asset["สถานะแจ้งซ่อม"] = (db.maintenanceStatusChoices || [])[0] || "ยังไม่เคยแจ้งซ่อม";
  if (!asset["รูปภาพครุภัณฑ์"]) asset["รูปภาพครุภัณฑ์"] = "";

  db.assets = [asset, ...(db.assets || [])];
  await writeDb(db);
  res.json({ ok: true, asset });
});

app.put("/api/assets/:id", adminRequired, async (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};
  const db = await readDb();
  const idx = (db.assets || []).findIndex(a => a.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, message: "ไม่พบรายการ" });

  const original = db.assets[idx];
  db.assets[idx] = { ...original, ...updates, id: original.id };

  await writeDb(db);
  res.json({ ok: true, asset: db.assets[idx] });
});

app.delete("/api/assets/:id", adminRequired, async (req, res) => {
  const id = req.params.id;
  const db = await readDb();
  const before = (db.assets || []).length;
  db.assets = (db.assets || []).filter(a => a.id !== id);
  const after = db.assets.length;
  if (after === before) return res.status(404).json({ ok: false, message: "ไม่พบรายการ" });
  await writeDb(db);
  res.json({ ok: true });
});

app.post("/api/assets/:id/image", adminRequired, upload.single("image"), async (req, res) => {
  const id = req.params.id;
  const db = await readDb();
  const idx = (db.assets || []).findIndex(a => a.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, message: "ไม่พบรายการ" });

  const filename = req.file?.filename;
  if (!filename) return res.status(400).json({ ok: false, message: "ไม่พบไฟล์รูป" });

  db.assets[idx]["รูปภาพครุภัณฑ์"] = `/assets/images/${filename}`;
  await writeDb(db);
  res.json({ ok: true, imagePath: db.assets[idx]["รูปภาพครุภัณฑ์"] });
});

app.get("/api/assets/:id/qr", async (req, res) => {
  const id = req.params.id;
  const db = await readDb();
  const asset = (db.assets || []).find(a => a.id === id);
  if (!asset) return res.status(404).send("Not found");

  const code = (asset["รหัสเครื่องมือห้องปฏิบัติการ"] || "").toString();
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const url = `${baseUrl}/qr.html?code=${encodeURIComponent(code)}`;

  try {
    const png = await QRCode.toBuffer(url, { type: "png", width: 420, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (e) {
    res.status(500).send("QR error");
  }
});

/** Public update from QR (optional): require login token (admin or user) */
app.put("/api/assets/by-code/:code", authRequired, async (req, res) => {
  const code = (req.params.code || "").toString();
  const updates = req.body || {};
  const db = await readDb();
  const idx = (db.assets || []).findIndex(a => (a["รหัสเครื่องมือห้องปฏิบัติการ"] || "").toString() === code);
  if (idx < 0) return res.status(404).json({ ok: false, message: "ไม่พบรายการ" });

  // allow any logged-in user to update only maintenance + note fields
  const allowed = new Set(["สถานะแจ้งซ่อม", "หมายเหตุการซ่อม", "วันที่แจ้งซ่อมล่าสุด"]);
  const sanitized = {};
  for (const k of Object.keys(updates)) {
    if (req.user.r === "admin" || allowed.has(k)) sanitized[k] = updates[k];
  }

  db.assets[idx] = { ...db.assets[idx], ...sanitized };
  await writeDb(db);
  res.json({ ok: true, asset: db.assets[idx] });
});

app.get("*", (req, res) => {
  // SPA fallback
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`MEM System running on http://localhost:${PORT}`);
});
