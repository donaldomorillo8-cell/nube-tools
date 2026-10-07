# Nube Tools — instalación independiente

Este ZIP es una aplicación Node.js autónoma: contiene la web, el servidor y el procesamiento de archivos. No requiere Replit, una cuenta de Replit, un monorepo ni un proxy propio de Replit.

## Necesitas

- Node.js 22 o posterior.
- Una cuenta de Clerk propia y sus claves.
- FFmpeg, FFprobe, LibreOffice y `pdftotext` (Poppler) instalados y disponibles en `PATH`.

En Ubuntu/Debian puedes instalar los programas de procesamiento así:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg libreoffice poppler-utils
```

## Instalación

1. Descomprime el ZIP en el servidor.
2. Copia `.env.example` a `.env`.
3. En `.env`, reemplaza los valores de ejemplo por las claves de tu instancia de Clerk. No subas ese archivo a Git.
4. En el panel de Clerk, activa Google y autoriza el dominio donde alojarás la web.
5. Instala y arranca el proyecto:

```sh
npm ci
npm start
```

El servidor escucha en `PORT` (por defecto, `8080`) y entrega desde el mismo dominio la interfaz y la API. Coloca un proxy HTTPS de tu proveedor de alojamiento delante del puerto de Node.js y conserva la ruta `/api` en ese mismo dominio. Así no tienes que configurar CORS entre la web y la API.

Para comprobar que arrancó, abre `https://tu-dominio/api/healthz`. La respuesta esperada es `{"status":"ok"}`.

## Archivos

- `public/index.html`: página de entrada en español.
- `public/styles.css`: estilos de la interfaz.
- `public/app.js`: aplicación JavaScript optimizada para producción.
- `server/index.js`: servidor HTTP, autenticación y rutas de la API.
- `server/fileProcessing.js`: lógica de conversión y procesamiento.

El marcador de la clave publicable de Clerk se reemplaza al servir `app.js`, usando la variable `CLERK_PUBLISHABLE_KEY` del servidor. No necesitas compilar la interfaz ni poner claves dentro del HTML o JavaScript.

## Operaciones y límites

- TXT, MD y CSV → PDF, DOCX o PPTX.
- PDF → DOCX o PPTX mediante extracción de texto; el diseño original no se conserva fielmente y no se aplica OCR a PDFs escaneados.
- DOCX y PPTX → PDF.
- PNG y JPG → PDF.
- MP4, MOV, MKV, WEBM, AVI y M4V → MP4 comprimido.
- Reduce el canal central de videos con audio estéreo. No es separación de voz mediante IA y puede reducir otros sonidos centrados.

El límite por archivo es 250 MB. Los resultados viven temporalmente en el servidor durante un máximo de 30 minutos. Se guardan en el directorio temporal del sistema, no en una base de datos; al reiniciar el servidor, los enlaces de descarga existentes dejan de ser válidos.

## Producción

Usa HTTPS y mantén `CLERK_SECRET_KEY` solo en el entorno privado del servidor. Si tu proveedor utiliza un administrador de procesos, configura `npm start` como servicio persistente y establece `PORT` desde ese proveedor.
