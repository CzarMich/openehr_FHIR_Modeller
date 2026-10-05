import { readFileSync } from "node:fs";
import { extname } from "node:path";

const LIMIT = 240000;
export async function extract(path, name) {
    const bytes = readFileSync(path),
        extension = extname(name).toLowerCase();
    let text = "",
        truncated = false;
    const append = (value) => {
        const room = LIMIT - text.length;
        if (value.length > room) truncated = true;
        text += value.slice(0, room);
    };
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (png || jpeg || [".png", ".jpg", ".jpeg"].includes(extension)) {
        if (!png && !jpeg) throw new Error("Invalid image");
        const { default: sharp } = await import("sharp");
        sharp.cache(false);
        sharp.concurrency(1);
        const source = sharp(bytes, { limitInputPixels: 20000000, failOn: "warning" });
        const metadata = await source.metadata();
        if (!["png", "jpeg"].includes(metadata.format) || (metadata.pages || 1) !== 1)
            throw new Error("Unsupported image");
        const { data, info } = await source
            .rotate()
            .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 85 })
            .toBuffer({ resolveWithObject: true });
        if (data.length > 2 * 1024 * 1024) throw new Error("Image preview too large");
        return {
            text: "",
            status: "image",
            note: "Image ready for the assistant. A prepared copy (up to 2048 pixels per side) is used; crop small or unclear text for better results. The original is kept.",
            image: { data: data.toString("base64"), mimeType: "image/jpeg", width: info.width, height: info.height },
        };
    } else if (extension === ".pdf" || bytes.subarray(0, 5).toString() === "%PDF-") {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = getDocument({
            data: new Uint8Array(bytes),
            isEvalSupported: false,
            useSystemFonts: false,
            disableFontFace: true,
            useWorkerFetch: false,
            verbosity: 0,
        });
        const doc = await task.promise;
        try {
            for (let page = 1; page <= Math.min(doc.numPages, 200) && text.length < LIMIT; page++) {
                const content = await (await doc.getPage(page)).getTextContent();
                append(
                    `\n[Page ${page}]\n` + content.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join(""),
                );
            }
            if (doc.numPages > 200 || text.length === LIMIT) truncated = true;
        } finally {
            await task.destroy();
        }
        if (!text.replace(/\[Page \d+\]/g, "").trim())
            return {
                text: "",
                status: "no_text",
                note: "No selectable text found. Upload a text version or attach the relevant scanned pages as PNG/JPG images.",
            };
    } else if ([".xlsx", ".xls", ".ods", ".xlsb"].includes(extension)) {
        const XLSX = await import("xlsx");
        const book = XLSX.read(bytes, {
            type: "buffer",
            sheetRows: 5001,
            cellFormula: false,
            cellHTML: false,
            bookVBA: false,
        });
        for (const name of book.SheetNames.slice(0, 30)) {
            const sheet = book.Sheets[name];
            if (sheet["!fullref"] && sheet["!fullref"] !== sheet["!ref"]) truncated = true;
            append(`\n[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(sheet));
        }
        if (book.SheetNames.length > 30) truncated = true;
    } else if (extension === ".docx") {
        const { default: mammoth } = await import("mammoth");
        append((await mammoth.extractRawText({ buffer: bytes })).value);
    } else {
        let encoding = "utf-8";
        if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
        if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
        try {
            const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
            if (/[\x00-\x08\x0b\x0e-\x1f]/.test(decoded)) throw new Error("Binary");
            append(decoded);
        } catch {
            return {
                text: "",
                status: "unsupported",
                note: "Original saved. This binary format has no text extractor; upload a PDF, spreadsheet, DOCX or text version to use its content.",
            };
        }
    }
    return {
        text,
        status: truncated ? "partial" : text.trim() ? "ready" : "no_text",
        note: truncated
            ? "Extraction reached a page, row, sheet or text limit. Only the extracted portion is available to the assistant."
            : text.trim()
              ? "Text extracted. Tables and page layout may need review against the original."
              : "No text found in this file.",
    };
}

// A separate, memory-bounded process keeps malformed document work off the HTTP loop.
if (process.send)
    process.once("message", async ({ path, name }) => {
        try {
            process.send(await extract(path, name), () => process.exit(0));
        } catch (error) {
            process.send(
                {
                    text: "",
                    status: "failed",
                    note:
                        extname(name).toLowerCase() === ".pdf"
                            ? error?.name === "PasswordException"
                                ? "Original saved. This PDF needs a password. Upload an unlocked copy to use its content."
                                : "Original saved, but the PDF could not be read. Try exporting it again, or attach the relevant pages as PNG/JPG images."
                            : "Original saved, but it could not be prepared. It may be damaged, password protected, animated, or exceed the 20-megapixel image limit. Try a smaller image or another export.",
                },
                () => process.exit(0),
            );
        }
    });
