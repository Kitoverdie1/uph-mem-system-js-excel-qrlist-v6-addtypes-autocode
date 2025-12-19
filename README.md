# MEM System – คลังครุภัณฑ์และเครื่องมือแพทย์ โรงพยาบาลมหาวิทยาลัยพะเยา

เวอร์ชัน JavaScript (Node.js + Express) ใช้ไฟล์ `db.json` เป็นฐานข้อมูลหลัก

## 1) ติดตั้ง
ต้องมี Node.js (แนะนำ 18+)

```bash
cd uph-mem-system-js
npm install
```

## 2) รัน
```bash
npm start
```

เปิดเว็บ: http://localhost:3000

## 3) บัญชีทดสอบ
- Admin: `admin / admin123`
- User: `user / user123`

## 4) โครงสร้าง
- `server.js` : API + static server
- `db.json` : ฐานข้อมูล (ครุภัณฑ์/ผู้ใช้/ค่าตั้งต้น)
- `public/` : หน้าเว็บทั้งหมด
  - `index.html` : แอปหลัก (Login + Sidebar + Dashboard + Tables)
  - `qr.html` : หน้าดูข้อมูลจาก QR (เหมาะกับมือถือ)
  - `css/style.css`
  - `js/app.js`

## 5) QR
ระบบสร้าง QR ให้เปิด `qr.html?code=LAB-0001` เป็นต้น
