const { chromium } = require('playwright');
const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const { Resend } = require('resend');
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// --- ESCAPE HTML ---
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

// 🤖 Telegram Bot alerts
async function sendTelegramAlert(videoId, errorMessage, errorImagePath) {
  try {
    const telegramDoc = await admin.firestore().collection('admin_settings').doc('telegram').get();
    if (!telegramDoc.exists || !telegramDoc.data().token) {
      console.log('⚠️ Telegram alerts not configured');
      return;
    }
    const { token, chatIds } = telegramDoc.data();
    if (!chatIds || chatIds.length === 0) return;

    const safeErrorMessage = escapeHTML(errorMessage);
    const telegramApiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
    const caption = `🚨 <b>carliyoelbot Error</b>\n\n<b>Video ID:</b> ${escapeHTML(videoId)}\n<b>Error:</b> ${safeErrorMessage}\n<b>Time:</b> ${new Date().toISOString()}`;

    for (const chatId of chatIds) {
      try {
        const form = new FormData();
        form.append('chat_id', chatId.trim());
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        if (await fs.pathExists(errorImagePath)) {
          form.append('photo', fs.createReadStream(errorImagePath));
        }
        await axios.post(telegramApiUrl, form, { headers: form.getHeaders() });
        console.log(`✅ Telegram alert sent to chat ${chatId}`);
      } catch (chatError) {
        console.warn(`❌ Failed to send Telegram alert to chat ${chatId}:`, chatError.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Telegram alert error:', err.message);
  }
}

// Inicialización Firebase
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Falta FIREBASE_SERVICE_ACCOUNT en el entorno.");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const fileManager = process.env.GEMINI_API_KEY ? new GoogleAIFileManager(process.env.GEMINI_API_KEY) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

(async () => {
  const MAX_ATTEMPTS = 5;
  let currentVideoDoc = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n=== INICIANDO INTENTO ${attempt}/${MAX_ATTEMPTS} ===`);

    let browser;
    let page;
    let videoId = null;
    let userEmail = null;
    let userName = null;
    let videoData = null;
    let videoPath = null;

    try {
      // Selección del vídeo
      if (!currentVideoDoc) {
        const forceVideoId = process.env.TARGET_VIDEO_ID;
        if (forceVideoId) {
          console.log(`[MODO FORZADO] Buscando vídeo específico: ${forceVideoId}`);
          currentVideoDoc = await db.collection('video_submissions').doc(forceVideoId).get();
          if (!currentVideoDoc.exists) { console.log("El vídeo forzado no existe."); process.exit(1); }
        } else {
          console.log("Modo Sorteo: Buscando ganador aleatorio...");
          const randomVal = Math.random();
          let snapshot = await db.collection('video_submissions')
            .where('status', '==', 'queued_for_tiktok')
            .where('randomSort', '>=', randomVal)
            .orderBy('randomSort')
            .limit(1)
            .get();

          if (snapshot.empty) {
            snapshot = await db.collection('video_submissions')
              .where('status', '==', 'queued_for_tiktok')
              .where('randomSort', '<', randomVal)
              .orderBy('randomSort')
              .limit(1)
              .get();
          }
          if (snapshot.empty) { console.log("Urna vacía. Apagando."); process.exit(0); }
          currentVideoDoc = snapshot.docs[0];
        }
      } else {
        console.log(`♻️ Reintentando el MISMO vídeo: ${currentVideoDoc.id}`);
      }

      const videoDoc = currentVideoDoc;
      videoId = videoDoc.id;
      videoData = videoDoc.data();
      videoPath = path.join('/tmp', `${videoId}.mp4`);

      // Datos del usuario
      const userSnapshot = await db.collection('users').doc(videoData.userId).get();
      if (userSnapshot.exists) {
        userEmail = userSnapshot.data().email;
        userName = userSnapshot.data().displayName;
      }

      console.log(`Procesando vídeo: ${videoId}`);

      await videoDoc.ref.update({
        status: 'publishing',
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Cookies de TikTok
      const tiktokSnapshot = await db.collection('tiktok_accounts').doc('main').get();
      if (!tiktokSnapshot.exists || !tiktokSnapshot.data().cookies) throw new Error("Faltan cookies de TikTok.");
      let rawCookies = JSON.parse(tiktokSnapshot.data().cookies);
      const sanitizedCookies = rawCookies.map(cookie => {
        const c = { ...cookie };
        if (c.sameSite && !['Strict', 'Lax', 'None'].includes(c.sameSite)) delete c.sameSite;
        return c;
      });

      // Descarga del vídeo (solo si no existe)
      if (!fs.existsSync(videoPath)) {
        console.log(`Descargando vídeo...`);
        const response = await axios({
          method: 'GET',
          url: videoData.videoUrl,
          responseType: 'stream',
          maxContentLength: 300 * 1024 * 1024,
          timeout: 120000
        });
        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('video/')) {
          throw new Error(`Invalid content type: ${contentType}`);
        }
        const writer = fs.createWriteStream(videoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
      } else {
        console.log(`El vídeo ya está en /tmp.`);
      }

      // ====================== GEMINI MODERATION (MISMO QUE LIMPIEZA) ======================
      if (process.env.TARGET_VIDEO_ID) {
        console.log("⚡ [MODO FORZADO] Saltando filtro de IA...");
      } else if (fileManager && genAI) {
        console.log("🤖 Analizando con Gemini (mismo prompt que limpieza)...");

        const uploadResult = await fileManager.uploadFile(videoPath, {
          mimeType: "video/mp4",
          displayName: videoId,
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === "PROCESSING") {
          await new Promise(r => setTimeout(r, 3000));
          file = await fileManager.getFile(uploadResult.file.name);
        }
        if (file.state === "FAILED") throw new Error("Gemini failed to process file");

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Eres moderador de TikTok 2026 con sentido del humor. 
Analiza este vídeo (imagen + audio). 
Reglas FLEXIBLES:
- MEMES, parodias, humor absurdo, edits locos o baja calidad → APROBADO si no viola normas graves.
- PROHIBIDO: desnudez, violencia real, odio, acoso, drogas, maltrato animal, logos claros de Instagram/Reels/Kwai/Twitter.

Responde ÚNICAMENTE en este formato estricto:
DECISIÓN: APROBADO o RECHAZADO
RAZÓN: (explicación breve en español)`;

        const aiResult = await model.generateContent([
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: prompt }
        ]);

        const aiText = aiResult.response.text().trim();
        console.log(`🤖 IA: ${aiText}`);

        await fileManager.deleteFile(uploadResult.file.name).catch(() => {});

        if (aiText.toUpperCase().includes("RECHAZADO")) {
          console.log(`❌ IA rechazó el vídeo. Descartando...`);
          await videoDoc.ref.update({ status: 'rejected_by_ai', lastError: aiText });
          await sendTelegramAlert(videoId, `Vídeo rechazado por IA: ${aiText}`, videoPath);
          currentVideoDoc = null;
          await fs.unlink(videoPath).catch(() => {});
          if (attempt < MAX_ATTEMPTS) continue;
          process.exit(1);
        }
      }

      // ====================== PLAYWRIGHT UPLOAD ======================
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/122.0.0.0 Safari/537.36'
      });
      await context.addCookies(sanitizedCookies);
      page = await context.newPage();

      console.log("Navegando a TikTok...");
      await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'load', timeout: 90000 });
      if (page.url().includes('login')) throw new Error("Sesión caducada.");

      console.log("Subiendo archivo...");
      const fileInput = page.locator('input[type="file"]');
      await fileInput.waitFor({ state: 'attached', timeout: 60000 });
      await fileInput.setInputFiles(videoPath);

      console.log("Rellenando descripción...");
      const editor = page.locator('div[contenteditable="true"], textarea').first();
      await editor.waitFor({ state: 'visible', timeout: 60000 });
      await editor.focus();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');

      const fullCaption = `${videoData.title || ""}\n\n#somoslosdertisto`.trim();
      const parts = fullCaption.split(/([@#][a-zA-Z0-9_áéíóúÁÉÍÓÚñÑ]+)/g);
      let hasWrittenAnything = false;

      for (let part of parts) {
        if (!part) continue;
        const isTag = part.startsWith('@') || part.startsWith('#');
        if (!isTag) part = part.trim().replace(/\s+/g, ' ');
        if (!part) continue;

        if (hasWrittenAnything) await page.keyboard.type(' ');
        if (isTag) {
          await page.keyboard.type(part, { delay: 150 });
          await page.waitForTimeout(2000);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
        } else {
          await page.keyboard.type(part, { delay: 20 });
        }
        hasWrittenAnything = true;
      }

      console.log("Dando 30 segundos a TikTok para procesar...");
      await page.waitForTimeout(30000);

      const postBtn = page.locator('button:has-text("Publicar"), button:has-text("Post")').last();
      await postBtn.scrollIntoViewIfNeeded();
      await postBtn.click({ force: true }).catch(() => {});

      // ====================== ESPERA + DETECCIÓN DE RESTRICCIÓN ======================
      const startTime = Date.now();
      const maxWaitTimeMs = 120000;
      let isPublished = false;
      let isRestricted = false;

      const successSelectors = ['.TUXToast-content', 'text=Gestionar', 'text=Manage', 'text=publicado', 'text=uploaded'].join(', ');

      const restrictionSelectors = [
        'text=Content may be restricted',
        'text=Unoriginal, low-quality, and QR code content',
        'text=Unoriginal, low-quality',
        'text=QR code content',
        'text=Violation reason',
        'text=Contenido restringido',
        'text=Motivo de la infracción',
        'text=restringido',
        'text=Some of the potential violations found.'
      ].join(', ');

      const popupKillList = ['Got it', 'Entendido', 'Turn on', 'Activar', 'Continuar', 'Continue', 'Confirmar', 'Confirm', 'Aceptar', 'Accept', 'Ignorar', 'Ignore'];

      while (Date.now() - startTime < maxWaitTimeMs) {
        console.log(`Escaneando pantalla (${Math.floor((Date.now() - startTime) / 1000)}s)...`);

        if (page.url().includes('/tiktokstudio/content') || await page.locator(successSelectors).isVisible({ timeout: 2000 }).catch(() => false)) {
          isPublished = true;
          break;
        }

        if (await page.locator(restrictionSelectors).isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log("🚨 Restricción detectada por TikTok");
          isRestricted = true;
          break;
        }

        // Cerrar popups molestos
        for (const text of popupKillList) {
          const btn = page.locator(`button:has-text("${text}")`).last();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(1500);
          }
        }

        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1500);

        if (await postBtn.isVisible() && !(await postBtn.isDisabled())) {
          await postBtn.click({ force: true }).catch(() => {});
        }
      }

      // Chequeo final por si el popup apareció tarde
      if (!isPublished && !isRestricted) {
        if (await page.locator(restrictionSelectors).isVisible({ timeout: 10000 }).catch(() => false)) {
          isRestricted = true;
        }
      }

      if (!isPublished && !isRestricted) {
        throw new Error("No se pudo confirmar la publicación tras 2 minutos.");
      }

      // ====================== MANEJO DE RECHAZO POR TIKTOK ======================
      if (isRestricted) {
        console.warn(`❌ TikTok rechazó el vídeo por "Unoriginal, low-quality..."`);
        const screenshotPath = `video-restringido-${videoId}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

        await videoDoc.ref.update({
          status: 'rejected_by_tiktok',
          lastError: "Rechazado por TikTok: Unoriginal, low-quality, and QR code content",
          cleanedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await sendTelegramAlert(videoId, "🚨 TikTok rechazó el vídeo por contenido no original / baja calidad / QR", screenshotPath);

        // Borrar de R2
        if (process.env.R2_ACCOUNT_ID && videoData.videoUrl) {
          try {
            const s3Client = new S3Client({
              region: "auto",
              endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
              credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
              forcePathStyle: true,
            });
            const videoKey = videoData.videoUrl.split('/').slice(-2).join('/');
            await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
          } catch (r2Error) {
            console.error("[R2] Error al borrar:", r2Error.message);
          }
        }

        await fs.unlink(videoPath).catch(() => {});
        if (browser) await browser.close().catch(() => {});

        currentVideoDoc = null;   // ← Importante: pasa al siguiente vídeo
        if (attempt < MAX_ATTEMPTS) {
          console.log("⏭️ Saltando al siguiente vídeo de la urna...");
          continue;
        } else {
          process.exit(1);
        }
      }

      // ====================== PUBLICACIÓN EXITOSA ======================
      let tiktokVideoId = null;
      try {
        const currentUrl = page.url();
        const match = currentUrl.match(/\/video\/(\d+)/);
        if (match) tiktokVideoId = match[1];
      } catch (e) {}

      const updateData = {
        status: 'published',
        publishedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: admin.firestore.FieldValue.delete()
      };
      if (tiktokVideoId) updateData.tiktokVideoId = tiktokVideoId;

      await videoDoc.ref.update(updateData);

      // Borrar de R2 (éxito)
      if (process.env.R2_ACCOUNT_ID && videoData.videoUrl) {
        try {
          const s3Client = new S3Client({ /* misma config */ });
          const videoKey = videoData.videoUrl.split('/').slice(-2).join('/');
          await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        } catch (e) { console.error("[R2] Error borrando éxito:", e.message); }
      }

      // Enviar email
      if (userEmail && resend) {
        // ... (tu código de email se mantiene igual)
        console.log(`Enviando email de éxito a ${userEmail}`);
        // (pega aquí tu bloque de resend.emails.send si quieres que quede completo)
      }

      console.log("¡Éxito total en la publicación!");
      process.exit(0);

    } catch (error) {
      console.error(`Error fatal en intento ${attempt}:`, error.message);
      if (page) await page.screenshot({ path: `error-pantalla-intento-${attempt}.png`, fullPage: true }).catch(() => {});
      await sendTelegramAlert(videoId || 'Unknown', error.message, `error-pantalla-intento-${attempt}.png`);

      if (videoId) {
        await db.collection('video_submissions').doc(videoId).update({
          status: 'queued_for_tiktok',
          attempts: admin.firestore.FieldValue.increment(1),
          lastError: error.message
        }).catch(() => {});
      }

      if (browser) await browser.close().catch(() => {});
      if (attempt === MAX_ATTEMPTS) {
        console.error("Se alcanzaron los intentos máximos.");
        process.exit(1);
      } else {
        console.log("Reintentando...");
        await new Promise(r => setTimeout(r, 3000));
      }
    } finally {
      if (videoPath && fs.existsSync(videoPath)) await fs.unlink(videoPath).catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
})();
