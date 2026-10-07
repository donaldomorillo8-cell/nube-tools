import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";
import pptxgen from "pptxgenjs";
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60 * 1e3;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1e3;
const VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const DOCUMENT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".txt",
  ".md",
  ".csv",
  ".pdf",
  ".docx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg"
]);
const jobs = /* @__PURE__ */ new Map();
const activeJobsByUser = /* @__PURE__ */ new Map();
function activeJobCount(userId) {
  return activeJobsByUser.get(userId) ?? 0;
}
function startUserJob(userId) {
  activeJobsByUser.set(userId, activeJobCount(userId) + 1);
}
function finishUserJob(userId) {
  const remaining = activeJobCount(userId) - 1;
  if (remaining <= 0) activeJobsByUser.delete(userId);
  else activeJobsByUser.set(userId, remaining);
}
function supportedTools() {
  return [
    {
      id: "document-converter",
      title: "Convertir documentos",
      description: "Pasa texto, PDF, im\xE1genes y archivos de Office entre PDF, Word y PowerPoint en los formatos admitidos.",
      category: "documentos",
      formats: [
        "TXT, MD, CSV \u2192 PDF, DOCX, PPTX",
        "PDF \u2192 DOCX, PPTX",
        "DOCX, PPTX \u2192 PDF",
        "PNG, JPG \u2192 PDF"
      ]
    },
    {
      id: "video-compressor",
      title: "Reducir tama\xF1o de video",
      description: "Recodifica videos a MP4 para compartirlos con un tama\xF1o menor.",
      category: "video",
      formats: ["MP4, MOV, MKV, WEBM, AVI, M4V \u2192 MP4"]
    },
    {
      id: "center-voice-reducer",
      title: "Reducir voz centrada",
      description: "Reduce el canal central de una pista est\xE9reo. No es separaci\xF3n de voz mediante IA y el resultado depende de la mezcla original.",
      category: "audio",
      formats: ["Video con pista de audio est\xE9reo \u2192 MP4"]
    }
  ];
}
async function processUploadedFile(options) {
  const workDir = await mkdtemp(join(tmpdir(), "nube-tools-"));
  try {
    const sourceExtension = extname(options.originalName).toLowerCase();
    const inputPath = join(workDir, `source${sourceExtension}`);
    await copyFile(options.inputPath, inputPath);
    if (options.operation === "convert") {
      if (!options.outputFormat) {
        throw new Error("Elige un formato de salida.");
      }
      const output = await convertDocument(
        inputPath,
        sourceExtension,
        options.outputFormat,
        workDir
      );
      return await storeJob(options, {
        outputPath: output.path,
        workDir,
        outputExtension: `.${options.outputFormat}`,
        contentType: output.contentType,
        notice: output.notice
      });
    }
    if (!VIDEO_EXTENSIONS.has(sourceExtension)) {
      throw new Error("Sube un video en MP4, MOV, MKV, WEBM, AVI o M4V.");
    }
    if (options.operation === "compress-video") {
      const outputPath2 = join(workDir, "video-optimizado.mp4");
      await runCommand("ffmpeg", [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        "scale='min(1920,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        options.quality === "smaller" ? "31" : "27",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        options.quality === "smaller" ? "96k" : "128k",
        "-movflags",
        "+faststart",
        outputPath2
      ]);
      return await storeJob(options, {
        outputPath: outputPath2,
        workDir,
        outputExtension: ".mp4",
        contentType: "video/mp4",
        notice: "La compresi\xF3n depende del video original; algunos archivos ya optimizados pueden no reducirse."
      });
    }
    const probe = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      inputPath
    ]);
    const probeData = JSON.parse(probe.stdout);
    const audioStream = probeData.streams?.find(
      (stream) => stream.codec_type === "audio"
    );
    if (!audioStream) {
      throw new Error("Este video no contiene una pista de audio.");
    }
    if ((audioStream.channels ?? 1) < 2) {
      throw new Error(
        "Esta herramienta necesita una pista est\xE9reo; no modifica audio mono."
      );
    }
    const outputPath = join(workDir, "voz-reducida.mp4");
    await runCommand("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-af",
      "pan=stereo|c0=0.5*FL-0.5*FR|c1=0.5*FL-0.5*FR",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath
    ]);
    return await storeJob(options, {
      outputPath,
      workDir,
      outputExtension: ".mp4",
      contentType: "video/mp4",
      notice: "Se redujo el audio centrado en est\xE9reo. No separa voces con IA y tambi\xE9n puede atenuar otros sonidos centrados."
    });
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}
async function storeJob(options, result) {
  const processedSizeBytes = (await stat(result.outputPath)).size;
  const id = randomUUID();
  const safeBase = basename(options.originalName, extname(options.originalName)).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "archivo";
  const job = {
    id,
    userId: options.userId,
    outputPath: result.outputPath,
    workingDirectory: result.workDir,
    fileName: `${safeBase}${result.outputExtension}`,
    contentType: result.contentType,
    originalSizeBytes: options.originalSizeBytes,
    processedSizeBytes,
    expiresAt: Date.now() + JOB_TTL_MS,
    ...result.notice ? { notice: result.notice } : {}
  };
  jobs.set(id, job);
  return job;
}
async function convertDocument(inputPath, sourceExtension, outputFormat, workDir) {
  if (!DOCUMENT_EXTENSIONS.has(sourceExtension)) {
    throw new Error(
      "Ese formato no est\xE1 disponible. Consulta la lista de formatos admitidos."
    );
  }
  if ([".docx", ".pptx"].includes(sourceExtension) && outputFormat !== "pdf") {
    throw new Error("Los archivos DOCX y PPTX se pueden convertir a PDF.");
  }
  if ([".png", ".jpg", ".jpeg"].includes(sourceExtension) && outputFormat !== "pdf") {
    throw new Error("Las im\xE1genes PNG y JPG se convierten a PDF.");
  }
  if (sourceExtension === ".pdf" && !["docx", "pptx"].includes(outputFormat)) {
    throw new Error("El PDF se puede convertir a DOCX o PPTX.");
  }
  const outputPath = join(workDir, `convertido.${outputFormat}`);
  let notice;
  if ([".docx", ".pptx"].includes(sourceExtension)) {
    await runCommand("libreoffice", [
      "--headless",
      "-env:UserInstallation=file://" + join(workDir, "lo-profile"),
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      inputPath
    ]);
    const libreOfficePath = join(
      workDir,
      `${basename(inputPath, sourceExtension)}.pdf`
    );
    const { rename } = await import("node:fs/promises");
    await rename(libreOfficePath, outputPath);
  } else if (sourceExtension === ".pdf") {
    const { stdout: text } = await runCommand(
      "pdftotext",
      ["-layout", inputPath, "-"],
      COMMAND_TIMEOUT_MS,
      5e6
    );
    notice = "El texto se traslad\xF3 al formato seleccionado; el dise\xF1o y la posici\xF3n original de los elementos pueden cambiar.";
    if (outputFormat === "docx") {
      const document = new Document({
        sections: [
          {
            children: textLines(text).map((line) => new Paragraph({ text: line }))
          }
        ]
      });
      await writeFile(outputPath, await Packer.toBuffer(document));
    } else {
      await makePowerPoint(text, outputPath);
    }
  } else {
    const text = [".txt", ".md", ".csv"].includes(sourceExtension) ? await readFile(inputPath, "utf8") : "";
    if (outputFormat === "pdf") {
      if (sourceExtension === ".png" || sourceExtension === ".jpg" || sourceExtension === ".jpeg") {
        await makePdf(outputPath, void 0, inputPath);
      } else {
        await makePdf(outputPath, text);
      }
    } else if (outputFormat === "docx") {
      const document = new Document({
        sections: [
          {
            children: textLines(text).map((line) => new Paragraph({ text: line }))
          }
        ]
      });
      await writeFile(outputPath, await Packer.toBuffer(document));
    } else {
      await makePowerPoint(text, outputPath);
    }
  }
  return {
    path: outputPath,
    contentType: outputFormatContentType(outputFormat),
    ...notice ? { notice } : {}
  };
}
function textLines(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 0 ? lines : [""];
}
function outputFormatContentType(format) {
  if (format === "pdf") return "application/pdf";
  if (format === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}
function makePdf(outputPath, text, imagePath) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: true, margin: 56 });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => {
      void writeFile(outputPath, Buffer.concat(chunks)).then(resolve, reject);
    });
    if (imagePath) {
      document.image(imagePath, {
        fit: [500, 680],
        align: "center",
        valign: "center"
      });
    } else {
      const lines = textLines(text ?? "");
      for (const line of lines) {
        document.fontSize(11).text(line || " ", {
          continued: false,
          lineGap: 2
        });
      }
    }
    document.end();
  });
}
async function makePowerPoint(text, outputPath) {
  const presentation = new pptxgen();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "Nube Tools";
  presentation.subject = "Documento convertido";
  const lines = textLines(text);
  const chunks = [];
  for (let offset = 0; offset < lines.length; offset += 9) {
    chunks.push(lines.slice(offset, offset + 9));
  }
  if (chunks.length === 0) chunks.push([""]);
  for (let index = 0; index < chunks.length; index += 1) {
    const slide = presentation.addSlide();
    slide.addText(
      index === 0 ? "Documento convertido" : `Continuaci\xF3n ${index + 1}`,
      {
        x: 0.65,
        y: 0.4,
        w: 11,
        h: 0.7,
        fontFace: "Aptos Display",
        fontSize: 28,
        bold: true
      }
    );
    slide.addText(chunks[index].join("\n"), {
      x: 0.7,
      y: 1.45,
      w: 11.7,
      h: 5.2,
      fontFace: "Aptos",
      fontSize: 18,
      breakLine: false,
      valign: "top",
      margin: 0.1,
      paraSpaceAfter: 12
    });
  }
  const buffer = await presentation.write({ outputType: "nodebuffer" });
  await writeFile(outputPath, buffer);
}
function runCommand(command, args, timeoutMs = COMMAND_TIMEOUT_MS, stdoutLimit = 8e4) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutExceededLimit = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("El proceso tard\xF3 demasiado y se detuvo."));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (part) => {
      if (stdout.length + part.length > stdoutLimit) {
        stdoutExceededLimit = true;
      }
      stdout += part.slice(0, Math.max(0, stdoutLimit - stdout.length));
    });
    child.stderr.on("data", (part) => {
      stderr = (stderr + part).slice(-12e3);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `No se pudo iniciar ${command}. Verifica que el componente de procesamiento est\xE9 instalado.`,
          { cause: error }
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdoutExceededLimit) {
        reject(
          new Error(
            "El contenido extra\xEDdo supera el l\xEDmite seguro para una conversi\xF3n de texto."
          )
        );
      } else if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            stderr.trim() ? `No se pudo procesar el archivo: ${stderr.trim().slice(-900)}` : `El proceso ${command} termin\xF3 con c\xF3digo ${code}.`
          )
        );
      }
    });
  });
}
async function removeExpiredJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.expiresAt > now) continue;
    jobs.delete(id);
    await rm(job.workingDirectory, { recursive: true, force: true });
  }
}
setInterval(() => {
  void removeExpiredJobs().catch(() => void 0);
}, JOB_TTL_MS).unref();
export {
  MAX_UPLOAD_BYTES,
  activeJobCount,
  finishUserJob,
  jobs,
  processUploadedFile,
  removeExpiredJobs,
  startUserJob,
  supportedTools
};
