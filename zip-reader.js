(function () {
  const maximumExpandedSize = 150 * 1024 * 1024;
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  const jpegSignature = [255, 216, 255];
  const monthNames = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
  ];
  const crcTable = new Uint32Array(256);

  for (let index = 0; index < crcTable.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }

  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  function findEndOfCentralDirectory(view) {
    const minimumOffset = Math.max(0, view.byteLength - 22 - 65535);
    for (let offset = view.byteLength - 22; offset >= minimumOffset; offset--) {
      if (view.getUint32(offset, true) !== 0x06054b50) continue;
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) return offset;
    }
    throw new Error("Struktur arsip ZIP tidak valid atau tidak lengkap.");
  }

  function decodeFileName(bytes, isUtf8) {
    try {
      return new TextDecoder(isUtf8 ? "utf-8" : "windows-1252", { fatal: true })
        .decode(bytes).replace(/\\/g, "/");
    } catch (error) {
      throw new Error(`Nama file di ZIP tidak dapat dibaca: ${error.message}`);
    }
  }

  async function decompress(method, bytes, name, expectedSize) {
    if (method === 0) return bytes;
    if (method !== 8) throw new Error(`Kompresi ZIP untuk "${name}" tidak didukung (metode ${method}).`);
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Browser ini belum mendukung ZIP terkompresi. Coba Chrome atau Edge terbaru.");
    }
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = [];
      let totalSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > expectedSize || totalSize > maximumExpandedSize) {
          await reader.cancel();
          throw new Error("Ukuran hasil ekstraksi melebihi ukuran yang dinyatakan dalam ZIP.");
        }
        chunks.push(value);
      }
      const output = new Uint8Array(totalSize);
      let outputOffset = 0;
      chunks.forEach((chunk) => { output.set(chunk, outputOffset); outputOffset += chunk.length; });
      return output;
    } catch (error) {
      throw new Error(`File "${name}" gagal diekstrak dari ZIP: ${error.message}`);
    }
  }

  function mimeType(name, bytes) {
    const extension = name.split(".").pop().toLowerCase();
    if (extension === "png") return "image/png";
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "webp") return "image/webp";
    if (extension === "gif") return "image/gif";
    if (extension === "svg") return "image/svg+xml";
    if (extension === "json") return "application/json";
    if (extension === "txt") return "text/plain";
    return "application/octet-stream";
  }

  async function readArchiveEntries(archive, allowedExtensions) {
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const directoryOffset = findEndOfCentralDirectory(view);
    const diskNumber = view.getUint16(directoryOffset + 4, true);
    const directoryDisk = view.getUint16(directoryOffset + 6, true);
    const entriesOnDisk = view.getUint16(directoryOffset + 8, true);
    const entryCount = view.getUint16(directoryOffset + 10, true);
    const directorySize = view.getUint32(directoryOffset + 12, true);
    const directoryStart = view.getUint32(directoryOffset + 16, true);
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new Error("Arsip ZIP multi-disk tidak didukung.");
    }
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
      throw new Error("Arsip ZIP64 belum didukung.");
    }
    if (directoryStart + directorySize > directoryOffset) throw new Error("Indeks ZIP berada di luar batas arsip.");

    const entries = [];
    let offset = directoryStart;
    let expandedSize = 0;
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > directoryStart + directorySize || view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("Indeks file pada ZIP rusak.");
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const checksum = view.getUint32(offset + 16, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > directoryStart + directorySize) throw new Error("Entri file pada ZIP terpotong.");
      const name = decodeFileName(bytes.subarray(offset + 46, offset + 46 + nameLength), Boolean(flags & 0x0800));
      offset = entryEnd;
      const extension = name.split(".").pop().toLowerCase();
      if (name.endsWith("/") || !allowedExtensions.has(extension)) continue;
      if (flags & 0x0001) throw new Error(`File "${name}" terenkripsi dan tidak dapat dibaca.`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error(`File "${name}" memakai ZIP64 yang belum didukung.`);
      }
      expandedSize += uncompressedSize;
      if (expandedSize > maximumExpandedSize) throw new Error("Total ukuran hasil ekstraksi melebihi batas aman 150 MB.");
      if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error(`Header file "${name}" pada ZIP rusak.`);
      }
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > directoryStart || dataEnd > bytes.length) throw new Error(`Isi file "${name}" pada ZIP terpotong.`);
      const content = await decompress(method, bytes.subarray(dataStart, dataEnd), name, uncompressedSize);
      if (content.length !== uncompressedSize || crc32(content) !== checksum) {
        throw new Error(`File "${name}" rusak atau tidak lolos pemeriksaan integritas.`);
      }
      const type = mimeType(name, content);
      if (type === "image/png" && !pngSignature.every((byte, i) => content[i] === byte)) {
        throw new Error(`File "${name}" bukan PNG yang valid.`);
      }
      if (type === "image/jpeg" && !jpegSignature.every((byte, i) => content[i] === byte)) {
        throw new Error(`File "${name}" bukan JPEG yang valid.`);
      }
      entries.push({
        name: name.split("/").pop(), path: name,
        blob: new Blob([content], { type }),
        text: type === "application/json" || type === "text/plain" ? new TextDecoder("utf-8", { fatal: true }).decode(content) : undefined
      });
    }
    return entries;
  }

  async function readImageEntries(archive) {
    return readArchiveEntries(archive, new Set(["png", "jpg", "jpeg"]));
  }

  async function readContentEntries(archive) {
    return readArchiveEntries(archive, new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "json", "txt"]));
  }

  function photoNumber(path) {
    const baseName = path.split("/").pop().replace(/\.(?:png|jpe?g|webp|gif|bmp|svg)$/i, "");
    const match = baseName.match(/^(?:foto|photo)[-_ ]?([1-9])$/i) || baseName.match(/^([1-9])$/);
    return match ? Number(match[1]) : null;
  }

  function dateFromPhotoFilename(fileName) {
    const name = fileName.toLocaleLowerCase("id-ID");
    const monthPattern = monthNames.join("|").toLocaleLowerCase("id-ID");
    const namedDate = name.match(new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${monthPattern})\\s+(\\d{4})(?:\\D|$)`, "i"));
    if (namedDate) {
      const monthIndex = monthNames.findIndex((month) => month.toLocaleLowerCase("id-ID") === namedDate[2]);
      return validPhotoDate(Number(namedDate[3]), monthIndex + 1, Number(namedDate[1]));
    }
    const numericPatterns = [
      /(?:^|\D)(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4})(?:\D|$)/,
      /(?:^|\D)(\d{4})[-_. ](\d{1,2})[-_. ](\d{1,2})(?:\D|$)/,
      /(?:^|\D)(\d{2})(\d{2})(\d{4})(?:\D|$)/,
      /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/
    ];
    for (const [index, pattern] of numericPatterns.entries()) {
      const match = name.match(pattern);
      if (!match) continue;
      const [first, second, third] = match.slice(1).map(Number);
      const [year, month, day] = index === 1 || index === 3 ? [first, second, third] : [third, second, first];
      const date = validPhotoDate(year, month, day);
      if (date) return date;
    }
    return null;
  }

  function validPhotoDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }

  function mapPhotoEntries(entries, slotCount) {
    const sortedEntries = [...entries].sort((a, b) => a.path.localeCompare(b.path, "id", { numeric: true, sensitivity: "base" }));
    const photosByNumber = new Map();
    const overflowEntries = [];
    const duplicateNumbers = new Set();
    const datedEntries = sortedEntries
      .map((entry) => ({ entry, date: dateFromPhotoFilename(entry.name || entry.path.split("/").pop()) }))
      .filter(({ date }) => date)
      .sort((a, b) => a.date.getTime() - b.date.getTime() || a.entry.path.localeCompare(b.entry.path, "id", { numeric: true, sensitivity: "base" }));
    datedEntries.slice(0, slotCount).forEach(({ entry }, index) => photosByNumber.set(index + 1, entry));
    const datedEntrySet = new Set(datedEntries.map(({ entry }) => entry));
    sortedEntries.forEach((entry) => {
      if (datedEntrySet.has(entry)) return;
      const number = photoNumber(entry.path);
      if (number === null) overflowEntries.push(entry);
      else if (photosByNumber.has(number)) { duplicateNumbers.add(number); overflowEntries.push(entry); }
      else photosByNumber.set(number, entry);
    });
    let nextSlot = 1;
    overflowEntries.forEach((entry) => {
      while (photosByNumber.has(nextSlot) && nextSlot <= slotCount) nextSlot++;
      if (nextSlot <= slotCount) photosByNumber.set(nextSlot++, entry);
    });
    return { photosByNumber, duplicateNumbers, ignoredCount: Math.max(0, entries.length - photosByNumber.size) };
  }

  function tableRows() {
    return Array.from(document.querySelectorAll(".budget-table tbody tr"));
  }

  function fillActivityRows(activities) {
    if (!Array.isArray(activities)) return;
    const rows = tableRows();
    activities.slice(0, rows.length).forEach((item, index) => {
      const row = rows[index];
      const values = typeof item === "string" ? item.split("\t") : [];
      const get = (...keys) => {
        if (typeof item === "string") return "";
        const key = keys.find((candidate) => item && item[candidate] != null);
        return key ? String(item[key]) : "";
      };
      const date = typeof item === "string" ? values[0] : get("date", "tanggal", "day");
      const narrative = typeof item === "string" ? values[1] : get("narrative", "uraian", "activity", "kegiatan", "description");
      const amount = typeof item === "string" ? values[2] : get("amount", "dana", "penggunaanDana");
      const note = typeof item === "string" ? values[3] : get("note", "keterangan");
      if (date) row.cells[1].textContent = date;
      if (narrative) row.cells[2].textContent = narrative;
      if (amount) row.cells[3].textContent = amount;
      if (note) row.cells[4].textContent = note;
    });
  }

  function importText(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return 0;
    const activities = lines.map((line) => {
      const parts = line.includes("\t") ? line.split("\t") : line.split("|");
      return { date: (parts[0] || "").trim(), narrative: (parts[1] || "").trim(), amount: (parts[2] || "").trim(), note: (parts[3] || "").trim() };
    }).filter((row) => row.date && row.narrative);
    fillActivityRows(activities);
    return activities.length;
  }

  function importJson(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("JSON harus berisi objek atau daftar data.");
    const monthSelect = document.querySelector("#report-month");
    const yearSelect = document.querySelector("#report-year");
    const villageSelect = document.querySelector("#report-village");
    const period = data.period && typeof data.period === "object" ? data.period : data;
    if (period.year != null && yearSelect) {
      yearSelect.value = String(period.year);
      yearSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (period.month != null && monthSelect) {
      const month = typeof period.month === "number" ? period.month : monthNames.findIndex((name) => name.toLowerCase() === String(period.month).toLowerCase());
      if (month >= 0) {
        monthSelect.value = String(month >= 1 && month <= 12 && typeof period.month === "number" ? month - 1 : month);
        monthSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const village = period.village || period.desa || period.kelurahan;
    if (village && villageSelect) {
      villageSelect.value = String(village);
      villageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const babinsa = data.babinsa && typeof data.babinsa === "object" ? data.babinsa : data;
    const selectors = { name: ".babinsa-name", nama: ".babinsa-name", rank: ".babinsa-rank", pangkat: ".babinsa-rank", nrp: ".babinsa-nrp" };
    Object.entries(selectors).forEach(([key, selector]) => {
      if (babinsa[key] != null) document.querySelectorAll(selector).forEach((element) => { element.textContent = String(babinsa[key]); });
    });
    const activities = data.activities || data.kegiatan || data.rows || data.rincian || (Array.isArray(data) ? data : null);
    if (activities) fillActivityRows(activities);
  }

  async function importZipPayloads(files) {
    const archives = Array.from(files || []).filter((file) => /\.zip$/i.test(file.name));
    for (const archive of archives) {
      const entries = await readContentEntries(archive);
      const jsonEntries = entries.filter((entry) => /\.json$/i.test(entry.name));
      const txtEntries = entries.filter((entry) => /\.txt$/i.test(entry.name));
      for (const entry of jsonEntries) importJson(entry.text);
      for (const entry of txtEntries) importText(entry.text);
      const count = entries.filter((entry) => /^image\//.test(entry.blob.type)).length;
      const status = document.querySelector("#photo-status");
      if (status) {
        const parts = [`ZIP ${archive.name} dibaca`];
        if (count) parts.push(`${count} gambar`);
        if (jsonEntries.length) parts.push(`${jsonEntries.length} JSON diterapkan`);
        if (txtEntries.length) parts.push(`${txtEntries.length} TXT diterapkan`);
        status.textContent = parts.join("; ") + ".";
      }
    }
  }

  window.ZipImageReader = { readImageEntries, readContentEntries, mapPhotoEntries, dateFromPhotoFilename };

  // Input folder dan ZIP yang sudah tersedia di aplikasi; seluruh isi diproses di browser.
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!input || !["local-folder-input", "photo-files-input"].includes(input.id)) return;
    const files = Array.from(input.files || []);
    void importZipPayloads(files).catch((error) => {
      const status = document.querySelector("#photo-status");
      if (status) status.textContent = `ZIP gagal dibaca: ${error.message}`;
      console.error("Gagal membaca isi ZIP:", error);
    });
  });
})();
