/* QR page (public) */
const token = localStorage.getItem("mem_token") || "";

function authHeaders(){
  return token ? { "Authorization": "Bearer " + token } : {};
}
async function fetchJson(url, opts={}){
  const { method="GET", body=null } = opts;
  const headers = { ...authHeaders() };
  let payload;
  if (body){
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const txt = await res.text();
  let data;
  try{ data = JSON.parse(txt); } catch { data = { ok:false, message: txt || "Unknown error" }; }
  if(!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}
function esc(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function qparam(name){
  const u = new URL(location.href);
  return u.searchParams.get(name) || "";
}

async function load(){
  const code = qparam("code").trim();
  const kv = document.getElementById("qrKv");
  const imgBox = document.getElementById("qrImgBox");
  const caption = document.getElementById("qrCodeCaption");
  const btnDownloadQr = document.getElementById("btnDownloadQr");

  if(!code){
    caption.textContent = "ไม่พบรหัส (code)";
    kv.innerHTML = `<div class="alert error">ไม่พบ parameter <b>code</b></div>`;
    return;
  }

  caption.textContent = `รหัส: ${code}`;
  try{
    const meta = await fetchJson("/api/meta");
    fillMaintChoices(meta.maintenanceStatusChoices || []);
  }catch{}

  try{
    const r = await fetchJson(`/api/assets/by-code/${encodeURIComponent(code)}`);
    const a = r.asset;
    // image
    if(a["รูปภาพครุภัณฑ์"]){
      imgBox.innerHTML = `<img src="${esc(a["รูปภาพครุภัณฑ์"])}" alt="asset">`;
    }else{
      imgBox.innerHTML = `<div class="muted">ยังไม่มีรูปภาพ</div>`;
    }

    // kv list
    const keysLeft = ["ชื่อ","รุ่น","หมายเลขเครื่อง","AssetID","สถานะ","สถานะแจ้งซ่อม"];
    const keysRight = ["ต้นทุนต่อหน่วย","ประเภทครุภัณฑ์","หมวดครุภัณฑ์","สถานที่ใช้งาน (ปัจจุบัน)","วันที่แจ้งซ่อมล่าสุด","หมายเหตุการซ่อม"];
    const all = [...keysLeft, ...keysRight];
    kv.innerHTML = all.map(k=>`
      <div class="kvItem">
        <div class="kvKey">${esc(k)}</div>
        <div class="kvVal">${esc(a[k] ?? "-")}</div>
      </div>
    `).join("");

    // QR download link
    if(a.id){
      btnDownloadQr.href = `/api/assets/${encodeURIComponent(a.id)}/qr`;
      btnDownloadQr.setAttribute("download", `${code}_qr.png`);
    }

    // fill edit form
    document.getElementById("qrMaintSelect").value = (a["สถานะแจ้งซ่อม"] || "");
    document.getElementById("qrMaintDate").value = normalizeDate(a["วันที่แจ้งซ่อมล่าสุด"] || "");
    document.getElementById("qrMaintNote").value = (a["หมายเหตุการซ่อม"] || "");

    // login button
    const btnLogin = document.getElementById("btnQrLogin");
    if(token){
      btnLogin.textContent = "เข้าสู่ระบบแล้ว";
      btnLogin.disabled = true;
    }else{
      btnLogin.addEventListener("click", ()=> location.href = "/");
    }

    // save
    document.getElementById("btnQrSave").addEventListener("click", async ()=>{
      hideMsg();
      try{
        if(!token) throw new Error("กรุณา Login ก่อน");
        const payload = {
          "สถานะแจ้งซ่อม": document.getElementById("qrMaintSelect").value,
          "วันที่แจ้งซ่อมล่าสุด": document.getElementById("qrMaintDate").value || "",
          "หมายเหตุการซ่อม": document.getElementById("qrMaintNote").value || ""
        };
        await fetchJson(`/api/assets/by-code/${encodeURIComponent(code)}`, { method:"PUT", body: payload });
        showOk("บันทึกเรียบร้อยแล้ว");
      }catch(e){
        showErr(e.message || "บันทึกไม่สำเร็จ");
      }
    });

  }catch(e){
    kv.innerHTML = `<div class="alert error">${esc(e.message || "ไม่พบข้อมูล")}</div>`;
    imgBox.innerHTML = `<div class="muted">-</div>`;
  }
}

function normalizeDate(v){
  // accept YYYY-MM-DD or others; keep if valid
  const s = (v||"").toString().trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return "";
}

function fillMaintChoices(choices){
  const sel = document.getElementById("qrMaintSelect");
  sel.innerHTML = "";
  for(const c of choices){
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
}

function hideMsg(){
  document.getElementById("qrSaveMsg").classList.add("hidden");
  document.getElementById("qrSaveErr").classList.add("hidden");
}
function showOk(msg){
  const el = document.getElementById("qrSaveMsg");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function showErr(msg){
  const el = document.getElementById("qrSaveErr");
  el.textContent = msg;
  el.classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", load);
