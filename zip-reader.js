(function () {
  const LIMIT = 150 * 1024 * 1024;
  const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
  const JPEG = [255, 216, 255];
  const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let n = i; for (let b = 0; b < 8; b++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; crcTable[i] = n >>> 0; }
  function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
  function findEnd(view) { for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65535); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) return i; throw new Error("Struktur ZIP tidak valid."); }
  async function inflate(method, data, name, expected) {
    if (method === 0) return data;
    if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error(`Kompresi ${name} tidak didukung browser ini.`);
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks = []; let size = 0;
    while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > expected || size > LIMIT) { await reader.cancel(); throw new Error("Ukuran ekstraksi melewati batas 150 MB."); } chunks.push(result.value); }
    const output = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output;
  }
  function mime(name) { const ext = name.split(".").pop().toLowerCase(); return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", json: "application/json", txt: "text/plain" })[ext] || "application/octet-stream"; }
  async function readArchive(archive, includeText = false) {
    const bytes = new Uint8Array(await archive.arrayBuffer()), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = findEnd(view);
    const disk = view.getUint16(end + 4, true), dirDisk = view.getUint16(end + 6, true), diskCount = view.getUint16(end + 8, true), count = view.getUint16(end + 10, true), dirSize = view.getUint32(end + 12, true), dirStart = view.getUint32(end + 16, true);
    if (disk || dirDisk || diskCount !== count) throw new Error("ZIP multi-disk tidak didukung.");
    if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) throw new Error("ZIP64 belum didukung.");
    if (dirStart + dirSize > end) throw new Error("Indeks ZIP rusak.");
    const entries = []; let offset = dirStart, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > dirStart + dirSize || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Indeks ZIP rusak.");
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), checksum = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true), uncompressed = view.getUint32(offset + 24, true), nameLen = view.getUint16(offset + 28, true), extraLen = view.getUint16(offset + 30, true), commentLen = view.getUint16(offset + 32, true), local = view.getUint32(offset + 42, true);
      const entryEnd = offset + 46 + nameLen + extraLen + commentLen; if (entryEnd > dirStart + dirSize) throw new Error("Entri ZIP terpotong.");
      const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "windows-1252", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLen)).replace(/\\/g, "/"); offset = entryEnd;
      const ext = name.split(".").pop().toLowerCase(), allowed = ["png", "jpg", "jpeg", "webp", "gif", "svg", ...(includeText ? ["json", "txt"] : [])];
      if (name.endsWith("/") || !allowed.includes(ext)) continue;
      if (flags & 1) throw new Error(`${name} terenkripsi.`);
      if ([compressed, uncompressed, local].includes(0xffffffff)) throw new Error("ZIP64 belum didukung.");
      expanded += uncompressed; if (expanded > LIMIT) throw new Error("Total hasil ekstraksi melebihi 150 MB.");
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error(`Header ${name} rusak.`);
      const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), dataEnd = dataStart + compressed;
      if (dataEnd > dirStart || dataEnd > bytes.length) throw new Error(`Isi ${name} terpotong.`);
      const content = await inflate(method, bytes.subarray(dataStart, dataEnd), name, uncompressed);
      if (content.length !== uncompressed || crc32(content) !== checksum) throw new Error(`${name} gagal pemeriksaan integritas.`);
      const type = mime(name);
      if (type === "image/png" && !PNG.every((b, n) => content[n] === b)) throw new Error(`${name} bukan PNG valid.`);
      if (type === "image/jpeg" && !JPEG.every((b, n) => content[n] === b)) throw new Error(`${name} bukan JPEG valid.`);
      entries.push({ name: name.split("/").pop(), path: name, blob: new Blob([content], { type }), text: type === "application/json" || type === "text/plain" ? new TextDecoder("utf-8", { fatal: true }).decode(content) : undefined });
    }
    return entries;
  }
  function photoNumber(path) { const base = path.split("/").pop().replace(/\.(?:png|jpe?g|webp|gif|bmp|svg)$/i, ""), match = base.match(/^(?:foto|photo)[-_ ]?([1-9])$/i) || base.match(/^([1-9])$/); return match ? Number(match[1]) : null; }
  function dateFromPhotoFilename(fileName) {
    const name = fileName.toLocaleLowerCase("id-ID"), monthPattern = months.join("|").toLocaleLowerCase("id-ID"), named = name.match(new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${monthPattern})\\s+(\\d{4})(?:\\D|$)`, "i"));
    if (named) { const month = months.findIndex((value) => value.toLowerCase() === named[2]) + 1; const date = new Date(Number(named[3]), month - 1, Number(named[1])); if (date.getMonth() === month - 1 && date.getDate() === Number(named[1])) return date; }
    return null;
  }
  function mapPhotoEntries(entries, slotCount) {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, "id", { numeric: true, sensitivity: "base" })), photosByNumber = new Map(), overflow = [], duplicateNumbers = new Set();
    const dated = sorted.map((entry) => ({ entry, date: dateFromPhotoFilename(entry.name || entry.path) })).filter((item) => item.date).sort((a, b) => a.date - b.date);
    dated.slice(0, slotCount).forEach(({ entry }, index) => photosByNumber.set(index + 1, entry)); const datedSet = new Set(dated.map((item) => item.entry));
    sorted.forEach((entry) => { if (datedSet.has(entry)) return; const number = photoNumber(entry.path); if (!number) overflow.push(entry); else if (photosByNumber.has(number)) { duplicateNumbers.add(number); overflow.push(entry); } else photosByNumber.set(number, entry); });
    let next = 1; overflow.forEach((entry) => { while (photosByNumber.has(next) && next <= slotCount) next++; if (next <= slotCount) photosByNumber.set(next++, entry); });
    return { photosByNumber, duplicateNumbers, ignoredCount: Math.max(0, entries.length - photosByNumber.size) };
  }
  function fillRows(items) {
    if (!Array.isArray(items)) return; const rows = [...document.querySelectorAll(".budget-table tbody tr")];
    items.slice(0, rows.length).forEach((item, index) => { const cells = rows[index].cells, values = typeof item === "string" ? item.split("\t") : [item.date || item.tanggal, item.narrative || item.uraian || item.activity || item.kegiatan || item.description, item.amount || item.dana || item.penggunaanDana, item.note || item.keterangan]; values.slice(0, 4).forEach((value, i) => { if (value != null && String(value).trim()) cells[i + 1].textContent = String(value).trim(); }); });
  }
  function importText(text) { const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(line.includes("\t") ? "\t" : "|").map((part) => part.trim())).filter((parts) => parts[0] && parts[1]); fillRows(rows); return rows.length; }
  function importJson(text) {
    const data = JSON.parse(text); if (!data || typeof data !== "object") throw new Error("Format JSON tidak valid."); const period = data.period && typeof data.period === "object" ? data.period : data;
    const year = document.querySelector("#report-year"), month = document.querySelector("#report-month"), village = document.querySelector("#report-village");
    if (period.year != null && year) { year.value = String(period.year); year.dispatchEvent(new Event("change", { bubbles: true })); }
    if (period.month != null && month) { const index = typeof period.month === "number" ? period.month - 1 : months.findIndex((item) => item.toLowerCase() === String(period.month).toLowerCase()); if (index >= 0 && index < 12) { month.value = String(index); month.dispatchEvent(new Event("change", { bubbles: true })); } }
    const villageName = period.village || period.desa || period.kelurahan; if (villageName && village) { village.value = String(villageName); village.dispatchEvent(new Event("change", { bubbles: true })); }
    const person = data.babinsa && typeof data.babinsa === "object" ? data.babinsa : data;
    for (const [keys, selector] of [[["name", "nama"], ".babinsa-name"], [["rank", "pangkat"], ".babinsa-rank"], [["nrp"], ".babinsa-nrp"]]) { const key = keys.find((candidate) => person[candidate] != null); if (key) document.querySelectorAll(selector).forEach((el) => { el.textContent = String(person[key]); }); }
    const activities = data.activities || data.kegiatan || data.rows || data.rincian || (Array.isArray(data) ? data : null); if (activities) fillRows(activities);
  }
  async function importFolder(files) {
    const archives = [...files].filter((file) => /\.zip$/i.test(file.name)); if (!archives.length) { setTimeout(() => { const s = document.querySelector("#photo-status"); if (s) s.textContent = "Folder tidak berisi file ZIP."; }, 0); return; }
    let imageCount = 0, jsonCount = 0, activityCount = 0;
    for (const archive of archives) { const entries = await readArchive(archive, true); imageCount += entries.filter((entry) => entry.blob.type.startsWith("image/")).length; for (const entry of entries.filter((item) => /\.json$/i.test(item.name))) { importJson(entry.text); jsonCount++; } for (const entry of entries.filter((item) => /\.txt$/i.test(item.name))) activityCount += importText(entry.text); }
    const status = document.querySelector("#photo-status"); if (status) status.textContent = `${archives.length} ZIP dibaca; ${imageCount} gambar, ${jsonCount} JSON, ${activityCount} kegiatan TXT dimuat.`;
  }
  window.ZipImageReader = { readImageEntries: (archive) => readArchive(archive, false).then((entries) => entries.filter((entry) => ["image/png", "image/jpeg"].includes(entry.blob.type))), mapPhotoEntries, dateFromPhotoFilename };
  document.addEventListener("DOMContentLoaded", () => {
    const select = document.querySelector("#report-type"), folderInput = document.querySelector("#local-folder-input"), print = document.querySelector("#print-button");
    if (select) select.hidden = true;
    if (!folderInput || !print || document.querySelector("#upload-folder-button")) return;
    const button = document.createElement("button"); button.id = "upload-folder-button"; button.type = "button"; button.className = "print-button"; button.textContent = "Upload Folder ZIP"; button.setAttribute("aria-label", "Pilih folder yang berisi beberapa file ZIP"); print.before(button);
    button.addEventListener("click", () => { folderInput.value = ""; folderInput.click(); });
  });
  document.addEventListener("change", (event) => { if (event.target && event.target.id === "local-folder-input") void importFolder(Array.from(event.target.files || [])).catch((error) => { const status = document.querySelector("#photo-status"); if (status) status.textContent = `ZIP gagal dibaca: ${error.message}`; }); });
})();
