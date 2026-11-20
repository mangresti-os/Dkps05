(function () {
  const maximumExpandedSize = 150 * 1024 * 1024;
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  const jpegSignature = [255, 216, 255];
  const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[i] = value >>> 0;
  }
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  function findEnd(view) {
    const min = Math.max(0, view.byteLength - 22 - 65535);
    for (let i = view.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) return i;
    }
    throw new Error("Struktur arsip ZIP tidak valid atau tidak lengkap.");
  }
  async function inflate(method, data, name, expected) {
    if (method === 0) return data;
    if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error(`Kompresi file ${name} tidak didukung browser.`);
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected || size > maximumExpandedSize) { await reader.cancel(); throw new Error("Ukuran hasil ekstraksi ZIP melewati batas."); }
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }
  function getMime(name) {
    const ext = name.split(".").pop().toLowerCase();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", json: "application/json", txt: "text/plain" })[ext] || "application/octet-stream";
  }
  async function readArchiveEntries(archive, allowed) {
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEnd(view);
    const disk = view.getUint16(end + 4, true), dirDisk = view.getUint16(end + 6, true);
    const diskEntries = view.getUint16(end + 8, true), count = view.getUint16(end + 10, true);
    const dirSize = view.getUint32(end + 12, true), dirStart = view.getUint32(end + 16, true);
    if (disk || dirDisk || diskEntries !== count) throw new Error("Arsip ZIP multi-disk tidak didukung.");
    if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) throw new Error("Arsip ZIP64 belum didukung.");
    if (dirStart + dirSize > end) throw new Error("Indeks ZIP tidak valid.");
    const entries = [];
    let offset = dirStart, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > dirStart + dirSize || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Indeks file ZIP rusak.");
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const checksum = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true);
      const uncompressed = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true), entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > dirStart + dirSize) throw new Error("Entri file ZIP terpotong.");
      let name = new TextDecoder(flags & 0x0800 ? "utf-8" : "windows-1252", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, "/");
      offset = entryEnd;
      const ext = name.split(".").pop().toLowerCase();
      if (name.endsWith("/") || !allowed.has(ext)) continue;
      if (flags & 1) throw new Error(`File ${name} terenkripsi.`);
      if ([compressed, uncompressed, localOffset].includes(0xffffffff)) throw new Error(`File ${name} menggunakan ZIP64.`);
      expanded += uncompressed;
      if (expanded > maximumExpandedSize) throw new Error("Total hasil ekstraksi ZIP melebihi 150 MB.");
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Header ${name} rusak.`);
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const dataEnd = dataStart + compressed;
      if (dataEnd > dirStart || dataEnd > bytes.length) throw new Error(`Isi ${name} terpotong.`);
      const content = await inflate(method, bytes.subarray(dataStart, dataEnd), name, uncompressed);
      if (content.length !== uncompressed || crc32(content) !== checksum) throw new Error(`Isi ${name} gagal pemeriksaan integritas.`);
      const mime = getMime(name);
      if (mime === "image/png" && !pngSignature.every((b, n) => content[n] === b)) throw new Error(`${name} bukan PNG valid.`);
      if (mime === "image/jpeg" && !jpegSignature.every((b, n) => content[n] === b)) throw new Error(`${name} bukan JPEG valid.`);
      entries.push({ name: name.split("/").pop(), path: name, blob: new Blob([content], { type: mime }), text: mime === "application/json" || mime === "text/plain" ? new TextDecoder("utf-8", { fatal: true }).decode(content) : undefined });
    }
    return entries;
  }
  const imageTypes = new Set(["png", "jpg", "jpeg"]);
  const contentTypes = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "json", "txt"]);
  function photoNumber(path) {
    const base = path.split("/").pop().replace(/\.(?:png|jpe?g|webp|gif|bmp|svg)$/i, "");
    const match = base.match(/^(?:foto|photo)[-_ ]?([1-9])$/i) || base.match(/^([1-9])$/);
    return match ? Number(match[1]) : null;
  }
  function validDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }
  function dateFromPhotoFilename(fileName) {
    const name = fileName.toLocaleLowerCase("id-ID"), monthPattern = monthNames.join("|").toLocaleLowerCase("id-ID");
    const named = name.match(new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${monthPattern})\\s+(\\d{4})(?:\\D|$)`, "i"));
    if (named) return validDate(Number(named[3]), monthNames.findIndex((month) => month.toLowerCase() === named[2]) + 1, Number(named[1]));
    const patterns = [/(?:^|\D)(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4})(?:\D|$)/, /(?:^|\D)(\d{4})[-_. ](\d{1,2})[-_. ](\d{1,2})(?:\D|$)/, /(?:^|\D)(\d{2})(\d{2})(\d{4})(?:\D|$)/, /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/];
    for (const [i, pattern] of patterns.entries()) {
      const m = name.match(pattern); if (!m) continue;
      const [a, b, c] = m.slice(1).map(Number), [year, month, day] = i === 1 || i === 3 ? [a, b, c] : [c, b, a];
      const date = validDate(year, month, day); if (date) return date;
    }
    return null;
  }
  function mapPhotoEntries(entries, slotCount) {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, "id", { numeric: true, sensitivity: "base" }));
    const photosByNumber = new Map(), overflow = [], duplicateNumbers = new Set();
    const dated = sorted.map((entry) => ({ entry, date: dateFromPhotoFilename(entry.name || entry.path.split("/").pop()) })).filter((item) => item.date).sort((a, b) => a.date - b.date || a.entry.path.localeCompare(b.entry.path, "id", { numeric: true, sensitivity: "base" }));
    dated.slice(0, slotCount).forEach(({ entry }, index) => photosByNumber.set(index + 1, entry));
    const datedSet = new Set(dated.map(({ entry }) => entry));
    sorted.forEach((entry) => {
      if (datedSet.has(entry)) return;
      const number = photoNumber(entry.path);
      if (number === null) overflow.push(entry);
      else if (photosByNumber.has(number)) { duplicateNumbers.add(number); overflow.push(entry); }
      else photosByNumber.set(number, entry);
    });
    let next = 1;
    overflow.forEach((entry) => { while (photosByNumber.has(next) && next <= slotCount) next++; if (next <= slotCount) photosByNumber.set(next++, entry); });
    return { photosByNumber, duplicateNumbers, ignoredCount: Math.max(0, entries.length - photosByNumber.size) };
  }
  function fillActivities(items) {
    if (!Array.isArray(items)) return;
    const rows = [...document.querySelectorAll(".budget-table tbody tr")];
    items.slice(0, rows.length).forEach((item, index) => {
      const row = rows[index], values = typeof item === "string" ? item.split("\t") : [];
      const get = (...keys) => { const key = keys.find((k) => item && item[k] != null); return key ? String(item[key]) : ""; };
      const fields = typeof item === "string" ? values : [get("date", "tanggal", "day"), get("narrative", "uraian", "activity", "kegiatan", "description"), get("amount", "dana", "penggunaanDana"), get("note", "keterangan")];
      fields.slice(0, 4).forEach((value, i) => { if (value) row.cells[i + 1].textContent = value.trim(); });
    });
  }
  function importText(text) {
    const activities = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(line.includes("\t") ? "\t" : "|").map((part) => part.trim())).filter((parts) => parts[0] && parts[1]);
    fillActivities(activities);
    return activities.length;
  }
  function importJson(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("JSON harus berisi objek atau daftar data.");
    const period = data.period && typeof data.period === "object" ? data.period : data;
    const yearSelect = document.querySelector("#report-year"), monthSelect = document.querySelector("#report-month"), villageSelect = document.querySelector("#report-village");
    if (period.year != null && yearSelect) { yearSelect.value = String(period.year); yearSelect.dispatchEvent(new Event("change", { bubbles: true })); }
    if (period.month != null && monthSelect) {
      const month = typeof period.month === "number" ? period.month - 1 : monthNames.findIndex((name) => name.toLowerCase() === String(period.month).toLowerCase());
      if (month >= 0 && month < 12) { monthSelect.value = String(month); monthSelect.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    const village = period.village || period.desa || period.kelurahan;
    if (village && villageSelect) { villageSelect.value = String(village); villageSelect.dispatchEvent(new Event("change", { bubbles: true })); }
    const person = data.babinsa && typeof data.babinsa === "object" ? data.babinsa : data;
    for (const [keys, selector] of [[ ["name", "nama"], ".babinsa-name" ], [ ["rank", "pangkat"], ".babinsa-rank" ], [ ["nrp"], ".babinsa-nrp" ]]) {
      const key = keys.find((candidate) => person[candidate] != null);
      if (key) document.querySelectorAll(selector).forEach((element) => { element.textContent = String(person[key]); });
    }
    const activities = data.activities || data.kegiatan || data.rows || data.rincian || (Array.isArray(data) ? data : null);
    if (activities) fillActivities(activities);
  }
  async function importZip(files) {
    const archives = [...files].filter((file) => /\.zip$/i.test(file.name));
    let imageEntries = [], jsonCount = 0, textCount = 0;
    for (const archive of archives) {
      const entries = await readArchiveEntries(archive, contentTypes);
      imageEntries.push(...entries.filter((entry) => entry.blob.type.startsWith("image/")));
      for (const entry of entries.filter((item) => /\.json$/i.test(item.name))) { importJson(entry.text); jsonCount++; }
      for (const entry of entries.filter((item) => /\.txt$/i.test(item.name))) { textCount += importText(entry.text); }
    }
    const status = document.querySelector("#photo-status");
    if (status && archives.length) status.textContent = `${archives.length} ZIP dibaca; ${imageEntries.length} gambar, ${jsonCount} JSON, ${textCount} kegiatan TXT dimuat.`;
  }
  window.ZipImageReader = { readImageEntries: (archive) => readArchiveEntries(archive, imageTypes), readContentEntries: (archive) => readArchiveEntries(archive, contentTypes), mapPhotoEntries, dateFromPhotoFilename };

  // Ganti menu pilihan lampiran dengan satu tombol yang langsung memilih ZIP.
  document.addEventListener("DOMContentLoaded", () => {
    const reportType = document.querySelector("#report-type");
    const fileInput = document.querySelector("#photo-files-input");
    const printButton = document.querySelector("#print-button");
    if (reportType) reportType.hidden = true;
    if (!fileInput || !printButton || document.querySelector("#upload-zip-button")) return;
    const button = document.createElement("button");
    button.id = "upload-zip-button";
    button.type = "button";
    button.className = "print-button";
    button.textContent = "Upload ZIP";
    button.setAttribute("aria-label", "Upload ZIP berisi gambar, JSON, dan TXT");
    printButton.before(button);
    button.addEventListener("click", () => {
      fileInput.value = "";
      fileInput.accept = ".zip,application/zip";
      fileInput.multiple = false;
      fileInput.click();
    });
  });
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!input || !["local-folder-input", "photo-files-input"].includes(input.id)) return;
    void importZip(Array.from(input.files || [])).catch((error) => {
      const status = document.querySelector("#photo-status");
      if (status) status.textContent = `ZIP gagal dibaca: ${error.message}`;
      console.error("Gagal membaca isi ZIP:", error);
    });
  });
})();
