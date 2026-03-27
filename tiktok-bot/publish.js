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

// ==================== FUNCIONES AUXILIARES ====================

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

async function sendTelegramAlert(videoId, errorMessage, errorImagePath) {
  try {
    const telegramDoc = await admin.firestore().collection('admin_settings').doc('telegram').get();
    if (!telegramDoc.exists || !telegramDoc.data().token) return;

    const { token, chatIds } = telegramDoc.data();
    if (!chatIds?.length) return;

    const safeError = escapeHTML(errorMessage);
    const caption = `🚨 <b>carliyoelbot Error</b>\n\n<b>Video ID:</b> ${escapeHTML(videoId)}\n<b>Error:</b> ${safeError}\n<b>Hora:</b> ${new Date().toISOString()}`;

    for (const chatId of chatIds) {
      try {
        const form = new FormData();
        form.append('chat_id', chatId.trim());
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');

        if (await fs.pathExists(errorImagePath)) {
          form.append('photo', fs.createReadStream(errorImagePath));
        }

        await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, form, {
          headers: form.getHeaders()
        });
      } catch (e) {
        console.warn(`Telegram alert failed for chat ${chatId}:`, e.message);
      }
    }
  } catch (err) {
    console.warn('Telegram alert error:', err.message);
  }
}

// ==================== INICIALIZACIÓN ====================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Falta FIREBASE_SERVICE_ACCOUNT");
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
    console.log(`\n=== INTENTO ${attempt}/${MAX_ATTEMPTS} ===`);

    let browser;
    let page;
    let videoId = null;
    let videoData = null;
    let userEmail = null;

    try {
      // Selección del vídeo
      if (!currentVideoDoc) {
        const forceVideoId = process.env.TARGET_VIDEO_ID;

        if (forceVideoId) {
          console.log(`[FORZADO] Usando vídeo: ${forceVideoId}`);
          currentVideoDoc = await db.collection('video_submissions').doc(forceVideoId).get();
          if (!currentVideoDoc.exists) throw new Error("Vídeo forzado no existe");
        } else {
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

          if (snapshot.empty) {
            console.log("Urna vacía. Finalizando.");
            process.exit(0);
          }
          currentVideoDoc = snapshot.docs[0];
        }
      } else {
        console.log(`♻️ Reintentando el mismo vídeo: ${currentVideoDoc.id}`);
      }

      const videoDoc = currentVideoDoc;
      videoId = videoDoc.id;
      videoData = videoDoc.data();

      // Obtener email del usuario
      const userSnap = await db.collection('users').doc(videoData.userId).get();
      if (userSnap.exists) userEmail = userSnap.data().email;

      console.log(`Procesando vídeo: ${videoId} - "${videoData.title}"`);

      await videoDoc.ref.update({
        status: 'publishing',
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // ==================== COOKIES TIKTOK ====================
      const tiktokSnap = await db.collection('tiktok_accounts').doc('main').get();
      if (!tiktokSnap.exists || !tiktokSnap.data().cookies) throw new Error("Faltan cookies de TikTok");

      const rawCookies = JSON.parse(tiktokSnap.data().cookies);
      const sanitizedCookies = rawCookies.map(c => {
        const cookie = { ...c };
        if (cookie.sameSite && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) delete cookie.sameSite;
        return cookie;
      });

      const videoPath = path.join('/tmp', `${videoId}.mp4`);

      // Descargar vídeo si no existe
      if (!fs.existsSync(videoPath)) {
        console.log("Descargando vídeo desde R2...");
        const response = await axios({
          method: 'GET',
          url: videoData.videoUrl,
          responseType: 'stream',
          maxContentLength: 300 * 1024 * 1024,
          timeout: 120000
        });

        const writer = fs.createWriteStream(videoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      }

      // ==================== GEMINI - ANÁLISIS MUY ESTRICTO ====================
      if (!process.env.TARGET_VIDEO_ID && fileManager && genAI) {
        console.log("🔍 Analizando vídeo con Gemini (modo ULTRA ESTRICTO)...");

        const uploadResult = await fileManager.uploadFile(videoPath, {
          mimeType: "video/mp4",
          displayName: videoId,
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === "PROCESSING") {
          await new Promise(r => setTimeout(r, 4000));
          file = await fileManager.getFile(uploadResult.file.name);
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const strictPrompt = `Analiza este vídeo con atención para publicarlo en TikTok.

Rechaza el vídeo SI contiene cualquiera de estas cosas:
- Watermarks, logos, círculos superpuestos, iconos o texto flotante (especialmente círculos con texto como "to bi monstrar esto", "sígueme", etc.)
- Contenido claramente copiado o reutilizado de otras cuentas (duplicado visual)
- Desnudez, violencia gráfica, lenguaje de odio, promoción de drogas/alcohol/tabaco
- Contenido ilegal, estafas o spam

Sé especialmente estricto con:
- Cualquier logo, marca de agua o elemento gráfico superpuesto en el vídeo
- Texto que aparece en la pantalla de forma permanente o semi-permanente
- Círculos, bordes o elementos que parezcan añadidos después de grabar

NO rechaces por:
- Vídeos cortos, simples o con poca edición
- Calidad media o baja (siempre que no tenga watermark)
- Contenido repetitivo pero original

Responde **únicamente** con uno de estos formatos exactos:

APROBADO | [razón breve opcional]
RECHAZADO | [explicación clara del motivo, menciona si hay watermark/logo]`;

        const aiResult = await model.generateContent([
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: strictPrompt }
        ]);

        const aiText = aiResult.response.text().trim();
        console.log(`Gemini: ${aiText}`);

        await fileManager.deleteFile(uploadResult.file.name).catch(() => { });

        if (aiText.toUpperCase().includes("RECHAZADO")) {
          console.log(`❌ RECHAZADO por IA estricta`);
          await videoDoc.ref.update({ status: 'rejected_by_ai', lastError: aiText });
          await sendTelegramAlert(videoId, `Rechazado por IA: ${aiText}`, videoPath);
          await fs.unlink(videoPath).catch(() => { });
          currentVideoDoc = null;
          continue;
        }
      }

      // ==================== PLAYWRIGHT - PUBLICACIÓN ====================
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      await context.addCookies(sanitizedCookies);
      page = await context.newPage();

      await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'load', timeout: 90000 });

      // Subida del vídeo
      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(videoPath);

      // Rellenar caption
      const editor = page.locator('div[contenteditable="true"], textarea').first();
      await editor.waitFor({ state: 'visible', timeout: 60000 });
      await editor.focus();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');

      const fullCaption = `${videoData.title || ""}\n\n#somoslosdertisto`.trim();
      const parts = fullCaption.split(/([@#][a-zA-Z0-9_áéíóúÁÉÍÓÚñÑ]+)/g);
      let hasWrittenAnything = false;

      for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        if (!part) continue;
        const isTag = part.startsWith('@') || part.startsWith('#');
        if (!isTag) {
          part = part.trim().replace(/\s+/g, ' ');
          if (!part) continue;
        }
        if (hasWrittenAnything) await page.keyboard.type(' ');
        if (isTag) {
          console.log(`Escribiendo tag dinámico: ${part}`);
          await page.keyboard.type(part, { delay: 150 });
          await page.waitForTimeout(2000);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
        } else {
          await page.keyboard.type(part, { delay: 20 });
        }
        hasWrittenAnything = true;
      }

      // ==================== ESPERA DE PROCESAMIENTO ====================
      console.log("Esperando a que TikTok termine de procesar el vídeo y el check de copyright...");
      // Esperamos a que aparezca algún indicativo de que el check ha terminado o el botón esté listo
      await Promise.race([
        page.waitForSelector('text=No issues found, text=No se han detectado problemas, text=Check complete', { timeout: 60000 }),
        page.waitForTimeout(45000) // Backup de 45s si no detecta el texto
      ]).catch(() => {});

      const postBtn = page.locator('button:has-text("Publicar"), button:has-text("Post")').filter({ has: page.locator('visible=true') }).last();
      
      console.log("Esperando a que el botón de publicar esté habilitado...");
      await postBtn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      
      // Intentar asegurar que no está deshabilitado
      let isEnabled = false;
      for(let i=0; i<10; i++) {
        const disabled = await postBtn.getAttribute('disabled');
        if (disabled === null) { isEnabled = true; break; }
        await page.waitForTimeout(2000);
      }
      if (!isEnabled) console.log("Aviso: El botón parece seguir deshabilitado, pero intentaremos pulsar.");

      console.log("Haciendo clic en Publicar...");
      await postBtn.click({ force: true }).catch(e => console.error("Error al hacer clic:", e.message));
      
      // Captura inmediata post-clic para ver si aparece algún error rápido o popup
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `post-click-${videoId}.png` }).catch(() => {});

      // ==================== MEJOR DETECCIÓN DE RESTRICCIÓN TIKTOK ====================
      console.log("Esperando resultado de publicación (máx 90 segundos)...");

      let isPublished = false;
      let tiktokRejected = false;
      const startTime = Date.now();
      const maxWait = 120000; // Aumentado a 120s

      while (Date.now() - startTime < maxWait) {
        const timePassed = Math.floor((Date.now() - startTime) / 1000);
        const currentUrl = page.url();
        console.log(`   Escaneando pantalla (${timePassed}s) - URL: ${currentUrl.substring(0, 50)}...`);

        // 1. Éxito normal (SOLO vía URL por petición del usuario para evitar falsos positivos)
        if (currentUrl.includes('/tiktokstudio/content') || currentUrl.includes('/profile') || currentUrl.includes('/video/')) {
          console.log("✅ ¡Redirección de éxito detectada via URL!");
          isPublished = true;
          break;
        }

        // Loguear toasts para debug por si hay errores, pero sin confirmar éxito por texto
        const toastVisible = await page.locator('.TUXToast-content, .tux-toast').isVisible({ timeout: 500 }).catch(() => false);
        if (toastVisible) {
          const toastText = await page.locator('.TUXToast-content, .tux-toast').innerText().catch(() => "");
          console.log(`   Toast en pantalla: "${toastText}"`);
        }

        // 2. DETECCIÓN DE RESTRICCIÓN O ERRORES
        const restrictionTexts = [
          'Content may be restricted',
          'Unoriginal, low-quality, and QR code content',
          'Violation reason',
          'Some of the potential violations found',
          'Copyright infringement',
          'Something went wrong',
          'Upload failed',
          'Couldn\'t post video'
        ];

        for (const text of restrictionTexts) {
          const found = await page.locator(`text=${text}`).isVisible({ timeout: 500 }).catch(() => false);
          if (found) {
            tiktokRejected = true;
            console.log(`🚫 Detectado problema/restricción: "${text}"`);
            break;
          }
        }

        if (tiktokRejected) break;

        // Botón "Post anyway" o "Publicar de todos modos" (a veces aparece en popups)
        const postAnyway = page.locator('button:has-text("Post anyway"), button:has-text("Publicar de todos modos")').last();
        if (await postAnyway.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log("⚠️ Apareció modal de advertencia, pulsando 'Post anyway'...");
          await postAnyway.click({ force: true }).catch(() => {});
          await page.waitForTimeout(2000);
          continue;
        }

        // Cerrar popups molestos
        const popupTexts = [
          'Got it', 'Entendido', 'Turn on', 'Activar', 'Continuar', 'Continue', 
          'Confirmar', 'Aceptar', 'Ignore', 'Not now', 'No ahora', 'Close', 'Cerrar'
        ];
        for (const txt of popupTexts) {
          const btn = page.locator(`button:has-text("${txt}")`).last();
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await btn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(1200);
          }
        }

        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(2500);
      }

      // ==================== MANEJO DEL RESULTADO ====================
      if (tiktokRejected) {
        console.log("🚫 TikTok rechazó el vídeo por 'Unoriginal, low-quality...'");

        await videoDoc.ref.update({
          status: 'rejected_by_tiktok',
          lastError: 'TikTok: Unoriginal, low-quality, and QR code content'
        });

        // Capturar pantalla para debug
        const screenshotPath = `tiktok-restriction-${videoId}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

        await sendTelegramAlert(videoId, "TikTok rechazó el vídeo: Unoriginal, low-quality, and QR code content", screenshotPath);

        // Eliminar de R2
        if (process.env.R2_ACCOUNT_ID && videoData.videoUrl) {
          try {
            const s3 = new S3Client({
              region: "auto",
              endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
              credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
              },
              forcePathStyle: true,
            });
            const key = videoData.videoUrl.split('/').slice(-2).join('/');
            await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
            console.log(`[R2] Archivo eliminado: ${key}`);
          } catch (e) {
            console.error("Error eliminando de R2:", e.message);
          }
        }

        currentVideoDoc = null;
        if (browser) await browser.close();
        continue;   // ← Pasa al siguiente vídeo
      }

      if (!isPublished) {
        throw new Error("No se pudo confirmar la publicación ni la restricción tras 90 segundos.");
      }

      // ==================== ÉXITO ====================
      console.log("✅ Vídeo publicado con éxito!");

      // Extraer tiktokVideoId
      let tiktokVideoId = null;
      try {
        const currentUrl = page.url();
        const videoIdMatch = currentUrl.match(/\/video\/(\d+)/);
        if (videoIdMatch && videoIdMatch[1]) {
          tiktokVideoId = videoIdMatch[1];
        }
      } catch (e) {
        console.log("Could not extract TikTok video ID, continuing...");
      }

      await videoDoc.ref.update({
        status: 'published',
        publishedAt: admin.firestore.FieldValue.serverTimestamp(),
        tiktokVideoId: tiktokVideoId || admin.firestore.FieldValue.delete(),
        lastError: admin.firestore.FieldValue.delete()
      });

      // Eliminar de R2 tras éxito
      if (process.env.R2_ACCOUNT_ID && videoData.videoUrl) {
        try {
          const s3 = new S3Client({
            region: "auto",
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
              accessKeyId: process.env.R2_ACCESS_KEY_ID,
              secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
            forcePathStyle: true,
          });
          const key = videoData.videoUrl.split('/').slice(-2).join('/');
          await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
          console.log(`[R2] Archivo eliminado tras éxito: ${key}`);
        } catch (e) { console.error("Error eliminando de R2:", e.message); }
      }

      // Enviar email a través de Resend
      if (userEmail && resend) {
        const publicRef = await db.collection('public_settings').doc('tiktok').get();
        const tiktokUsername = publicRef.data()?.username || 'carliyoelbot';
        const tiktokUrl = `https://www.tiktok.com/@${tiktokUsername.replace('@', '')}`;

        await resend.emails.send({
          from: "carliyoelbot <tiktok-bot@carliyoelbot.com>",
          to: [userEmail],
          subject: "¡Ya estás en TikTok! 🎉⚽",
          html: `
            <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
              <div style="background-color: #214d72; padding: 30px 20px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 24px;">¡GOLAZO POR TODA LA ESCUADRA! ⚽</h1>
              </div>
              <div style="padding: 30px 20px; text-align: center; color: #333;">
                <p style="font-size: 16px; line-height: 1.5;">¡Enhorabuena! De entre todos los compas que están en la grada, nuestro bot ha sacado tu vídeo de la urna.</p>
                <div style="background-color: #f8fafc; border-left: 4px solid #00f2ea; padding: 15px; margin: 20px 0; text-align: left;">
                  <p style="margin: 0; font-size: 16px;">Tu vídeo: <br><strong>"${videoData.title}"</strong><br>acaba de ser publicado con éxito.</p>
                </div>
                <p style="font-size: 16px; line-height: 1.5;">Ve a nuestro perfil de TikTok, busca tu obra de arte y dale los primeros likes para que el algoritmo empiece a volar.</p>
                <div style="margin: 35px 0;">
                  <a href="${tiktokUrl}" style="background-color: #00f2ea; color: #000; padding: 16px 32px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; display: inline-block; text-transform: uppercase;">
                    Ir al perfil de TikTok
                  </a>
                </div>
              </div>
            </div>
          `
        }).catch(e => console.error("Error enviando email:", e));
      }

      currentVideoDoc = null;
      if (browser) await browser.close();
      process.exit(0);

    } catch (error) {
      console.error(`Error en intento ${attempt}:`, error.message);

      const screenshotPath = `error-intento-${attempt}.png`;
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });

      await sendTelegramAlert(videoId || 'unknown', error.message, screenshotPath);

      if (videoId) {
        await db.collection('video_submissions').doc(videoId).update({
          status: 'queued_for_tiktok',
          attempts: admin.firestore.FieldValue.increment(1),
          lastError: error.message
        }).catch(() => { });
      }

      if (browser) await browser.close().catch(() => { });

      if (attempt === MAX_ATTEMPTS) {
        console.error("Máximos intentos alcanzados. Finalizando.");
        process.exit(1);
      }

      currentVideoDoc = null;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
})();
