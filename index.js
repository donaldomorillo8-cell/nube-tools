import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer, { MulterError } from "multer";
import { clerkMiddleware, getAuth } from "@clerk/express";
import {
  activeJobCount,
  finishUserJob,
  jobs,
  MAX_UPLOAD_BYTES,
  processUploadedFile,
  supportedTools,
  startUserJob,
} from "./fileProcessing.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const appScriptPath = join(publicDirectory, "app.js");
const publishableKeyMarker = "__NUBE_TOOLS_CLERK_PUBLISHABLE_KEY__";

if (!clerkPublishableKey || !clerkSecretKey) {
  throw new Error(
    "Faltan CLERK_PUBLISHABLE_KEY o CLERK_SECRET_KEY. Configúralas en el archivo .env.",
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT debe ser un puerto válido.");
}

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

app.use(express.json({ limit: "1mb" }));
app.use(
  clerkMiddleware(() => ({
    publishableKey: clerkPublishableKey,
    secretKey: clerkSecretKey,
  })),
);

function requireAuth(req, res, next) {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Debes iniciar sesión para procesar archivos." });
    return;
  }
  req.authUserId = userId;
  next();
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

function isChoice(value, choices) {
  return value === undefined || choices.includes(value);
}

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/tools", (_req, res) => {
  res.json({ tools: supportedTools(), maxUploadBytes: MAX_UPLOAD_BYTES });
});

app.post(
  "/api/processing/jobs",
  requireAuth,
  (req, res, next) => {
    upload.single("file")(req, res, (error) => {
      if (error) {
        if (error instanceof MulterError && error.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "El archivo supera el límite de 250 MB." });
        } else {
          res.status(400).json({ error: "No se pudo recibir el archivo." });
        }
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const userId = req.authUserId;
    if (!req.file) {
      res.status(400).json({ error: "Selecciona un archivo para procesarlo." });
      return;
    }

    const operation = stringField(req.body.operation);
    const outputFormat = stringField(req.body.outputFormat);
    const quality = stringField(req.body.quality);
    const validOperation = [
      "convert",
      "compress-video",
      "reduce-centered-voice",
    ].includes(operation);
    const validFormat = isChoice(outputFormat || undefined, [
      "pdf",
      "docx",
      "pptx",
    ]);
    const validQuality = isChoice(quality || undefined, ["balanced", "smaller"]);
    if (!validOperation || !validFormat || !validQuality) {
      await rm(req.file.path, { force: true });
      res.status(400).json({ error: "La operación o sus opciones no son válidas." });
      return;
    }
    if (activeJobCount(userId) >= 2) {
      await rm(req.file.path, { force: true });
      res.status(429).json({
        error: "Ya hay dos procesos activos. Espera a que terminen.",
      });
      return;
    }

    startUserJob(userId);
    try {
      const job = await processUploadedFile({
        inputPath: req.file.path,
        originalName: req.file.originalname,
        originalSizeBytes: req.file.size,
        userId,
        operation,
        ...(outputFormat ? { outputFormat } : {}),
        ...(quality ? { quality } : {}),
      });
      res.status(201).json({
        jobId: job.id,
        fileName: job.fileName,
        contentType: job.contentType,
        originalSizeBytes: job.originalSizeBytes,
        processedSizeBytes: job.processedSizeBytes,
        downloadPath: `/api/processing/jobs/${job.id}/download`,
        ...(job.notice ? { notice: job.notice } : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "No fue posible procesar el archivo.";
      console.warn("File processing failed:", message);
      res.status(400).json({ error: message });
    } finally {
      await rm(req.file.path, { force: true });
      finishUserJob(userId);
    }
  },
);

app.get(
  "/api/processing/jobs/:jobId/download",
  requireAuth,
  async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.expiresAt <= Date.now() || job.userId !== req.authUserId) {
      if (job && job.expiresAt <= Date.now()) {
        jobs.delete(job.id);
        await rm(job.workingDirectory, { recursive: true, force: true });
      }
      res.status(404).json({
        error: "El resultado ya no está disponible. Procésalo de nuevo.",
      });
      return;
    }

    res.download(job.outputPath, job.fileName, (error) => {
      if (error && !res.headersSent) {
        console.warn("Processed download failed:", error.message);
        res.status(500).json({ error: "No se pudo descargar el resultado." });
      }
    });
  },
);

app.get("/app.js", async (_req, res, next) => {
  try {
    const source = await readFile(appScriptPath, "utf8");
    if (!source.includes(publishableKeyMarker)) {
      throw new Error("No se encontró el marcador de Clerk en public/app.js.");
    }
    res
      .type("application/javascript")
      .set("Cache-Control", "no-store")
      .send(source.replaceAll(publishableKeyMarker, clerkPublishableKey));
  } catch (error) {
    next(error);
  }
});

app.use(express.static(publicDirectory, { index: "index.html" }));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    res.sendFile(join(publicDirectory, "index.html"), (error) => {
      if (error) next(error);
    });
    return;
  }
  next();
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled request error:", error);
  if (!res.headersSent) {
    res.status(500).json({ error: "Ocurrió un error inesperado en el servidor." });
  }
});

const jobCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt > now) continue;
    jobs.delete(id);
    void rm(job.workingDirectory, { recursive: true, force: true });
  }
}, 5 * 60 * 1000);
jobCleanup.unref();

app.listen(port, "0.0.0.0", () => {
  console.log(`Nube Tools está escuchando en el puerto ${port}.`);
});
