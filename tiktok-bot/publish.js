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

// --- NUEVO: Función para escapar caracteres HTML conflictivos ---
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g,
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// 🤖 Telegram Bot alerts (configured via admin panel)
async function sendTelegramAlert(videoId, errorMessage, errorImagePath) {
  try {
    const telegramDoc = await admin.firestore().collection('admin_settings').doc('telegram').get();

    if (!telegramDoc.exists || !telegramDoc.data().token) {
      console.log('⚠️  Telegram alerts not configured, skipping notification');
      return;
    }

    const { token, chatIds } = telegramDoc.data();
    if (!chatIds || chatIds.length === 0) {
      console.log('⚠️  No Telegram chat IDs configured');
      return;
    }

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
          const fileStream = fs.createReadStream(errorImagePath);
          form.append('photo', fileStream);
        }

        await axios.post(telegramApiUrl, form, {
          headers: form.getHeaders()
        });

        console.log(`✅ Telegram alert sent to chat ${chatId}`);
      } catch (chatError) {
        console.warn(`❌ Failed to send Telegram alert to chat ${chatId}:`, chatError.response ? chatError.response.data : chatError.message);
      }
    }
  } catch (err) {
    console.warn('⚠️  Telegram alert error:', err.message);
  }
}

// Inicialización de Firebase
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
  // 🌟 NUEVO: Variable fuera del bucle para recordar el vídeo en caso de fallo ajeno
  let currentVideoDoc = null;

  // 🔴 NUEVO: Avisar a Firestore de que el bot de publicación HA ARRANCADO
  console.log("Notificando a Firestore: bot_status = running");
  await db.doc('system_stats/counters').set({
    bot_status: 'running',
    bot_started_at: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(e => console.error("Error al setear bot status running:", e));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n=== INICIANDO INTENTO ${attempt}/${MAX_ATTEMPTS} ===`);
    let browser;
    let page;
    let videoId = null;
    let userEmail = null;
    let userName = null;
    let videoData = null;

    try {
      // 🌟 NUEVO: Si no tenemos un vídeo retenido de un intento anterior, sacamos uno nuevo
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
        console.log(`♻️ Reintentando el MISMO vídeo por fallo de sistema anterior: ${currentVideoDoc.id}`);
      }

      // Asignamos los datos del vídeo retenido o extraído
      let videoDoc = currentVideoDoc;
      videoId = videoDoc.id;
      videoData = videoDoc.data();

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

      const tiktokSnapshot = await db.collection('tiktok_accounts').doc('main').get();
      if (!tiktokSnapshot.exists || !tiktokSnapshot.data().cookies) throw new Error("Faltan cookies de TikTok.");

      let rawCookies = JSON.parse(tiktokSnapshot.data().cookies);
      const sanitizedCookies = rawCookies.map(cookie => {
        const c = { ...cookie };
        if (c.sameSite && !['Strict', 'Lax', 'None'].includes(c.sameSite)) delete c.sameSite;
        return c;
      });

      const videoPath = path.join('/tmp', `${videoId}.mp4`);

      // Solo descargamos si el archivo no existe (por si es un reintento)
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
          throw new Error(`Invalid content type: ${contentType}. Expected video/*`);
        }
        const writer = fs.createWriteStream(videoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
      } else {
        console.log(`El vídeo ya está en /tmp. Saltando descarga.`);
      }

      // --- GEMINI MODERATION ---
      if (process.env.TARGET_VIDEO_ID) {
        console.log("⚡ [MODO FORZADO] Vídeo seleccionado manualmente. Saltando el filtro de IA...");
      } else if (fileManager && genAI) {
        console.log("Subiendo archivo a Gemini para moderación...");
        let uploadResult;
        try {
          uploadResult = await fileManager.uploadFile(videoPath, {
            mimeType: "video/mp4",
            displayName: videoId,
          });

          let file = await fileManager.getFile(uploadResult.file.name);
          process.stdout.write("Esperando a que el archivo esté procesado en Gemini");
          while (file.state === "PROCESSING") {
            process.stdout.write(".");
            await new Promise((resolve) => setTimeout(resolve, 5000));
            file = await fileManager.getFile(uploadResult.file.name);
          }
          console.log("");

          if (file.state === "FAILED") {
            throw new Error("El procesamiento de Gemini falló (FAILED statte).");
          }

          console.log(`Estado en Gemini: ACTIVE. Analizando con gemini-2.5-flash...`);
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const prompt = `Eres el moderador principal y ESTRICTO de una plataforma de vídeos. 
Tu trabajo es mantener la plataforma 100% segura y limpia. Analiza este vídeo (imagen + audio).

MOTIVOS DE RECHAZO DIRECTO (Rechaza si detectas ALGO de esto):
1. SPAM: Códigos de descuento (Shein, Temu, etc.), venta de productos, o autopromoción descarada.
2. GORE/SANGRE: Procedimientos médicos, órganos, heridas, o fluidos corporales (incluso si es "educativo").
3. PELIGRO: Peleas (incluso fingidas o jugando), llaves de lucha, conducción temeraria, o retos virales.
4. TOXICIDAD: Odio, acoso, insultos graves o discriminación.
5. PROHIBIDOS CLÁSICOS: Desnudez, violencia real, drogas, maltrato animal.
6. MARCAS DE AGUA: Logos visibles de Instagram, Reels, Kwai o Twitter.

EXCEPCIÓN: Bailes, gameplays, memes inofensivos y humor absurdo están APROBADOS siempre que no toquen las reglas anteriores.
Ante la duda de si algo es peligroso o spam, RECHÁZALO.

Responde ÚNICAMENTE en este formato estricto:
DECISIÓN: APROBADO o RECHAZADO
RAZÓN: (explicación técnica de 1 línea en español)`;

          // 🌟 NUEVO: Micro-reintentos por si Google devuelve 503
          let aiResponseText = null;
          let geminiAttempts = 0;
          const MAX_GEMINI = 3;

          while (geminiAttempts < MAX_GEMINI) {
            try {
              geminiAttempts++;
              const aiResult = await model.generateContent([
                { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
                { text: prompt },
              ]);
              aiResponseText = aiResult.response.text();
              break; // Éxito, salimos del bucle while
            } catch (apiError) {
              console.warn(`⚠️ Error temporal en API Gemini (Intento ${geminiAttempts}): ${apiError.message}`);
              if (geminiAttempts >= MAX_GEMINI) throw apiError;
              console.log("⏳ Esperando 10 segundos por saturación de Google antes de reintentar...");
              await new Promise(r => setTimeout(r, 10000));
            }
          }

          console.log(`Respuesta de IA: ${aiResponseText}`);

          // Cleaner
          await fileManager.deleteFile(uploadResult.file.name).catch(() => { });

          if (aiResponseText.includes("RECHAZADO")) {
            console.log(`❌ IA rechazó el vídeo (${videoId}). Descartando y pasando al siguiente.`);
            await videoDoc.ref.update({
              status: 'rejected_by_ai',
              lastError: aiResponseText
            });
            await sendTelegramAlert(videoId, `Vídeo rechazado por IA. Razón: ${aiResponseText}`, videoPath);
            await fs.unlink(videoPath).catch(() => console.log("No se pudo borrar video de /tmp"));

            // 🌟 NUEVO: Vaciamos el retenedor para que saque OTRO vídeo distinto en la siguiente vuelta
            currentVideoDoc = null;

            if (attempt < MAX_ATTEMPTS) {
              continue;
            } else {
              console.log("Alcanzados los máximos intentos.");
              process.exit(1);
            }
          } else {
            console.log("✅ IA aprobó el vídeo. Continuando a la publicación.");
          }
        } catch (geminiError) {
          throw new Error(`Fallo durante la moderación con Gemini: ${geminiError.message}`);
        }
      } else {
        console.warn("⚠️ GEMINI_API_KEY no configurado, omitiendo moderación por IA.");
      }

      // --- PLAYWRIGHT UPLOAD ---
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

      for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        if (!part) continue;

        const isTag = part.startsWith('@') || part.startsWith('#');

        if (!isTag) {
          part = part.trim().replace(/\s+/g, ' ');
          if (!part) continue;
        }

        if (hasWrittenAnything) {
          await page.keyboard.type(' ');
        }

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

      console.log("Dando 30 segundos a TikTok para procesar...");
      await page.waitForTimeout(30000);

      const postBtn = page.locator('button:has-text("Publicar"), button:has-text("Post")').last();
      await postBtn.scrollIntoViewIfNeeded();

      console.log("Haciendo clic inicial en Publicar...");
      try {
        await postBtn.click({ timeout: 5000, force: true });
      } catch (e) {
        console.log("Clic bloqueado inicialmente, buscando obstáculos...");
      }

      const startTime = Date.now();
      const maxWaitTimeMs = 120000;
      let isPublished = false;
      let isRestricted = false; // [NUEVO] Flag para detectar contenido restringido
      const successSelectors = ['.TUXToast-content', 'text=Gestionar', 'text=Manage', 'text=publicado', 'text=uploaded'].join(', ');

      const popupKillList = [
        'Got it', 'Entendido',
        'Turn on', 'Activar',
        'Continuar', 'Continue',
        'Confirmar', 'Confirm',
        'Aceptar', 'Accept',
        'Ignorar', 'Ignore'
      ];

      while (Date.now() - startTime < maxWaitTimeMs) {
        console.log(`Escaneando pantalla (${Math.floor((Date.now() - startTime) / 1000)}s)...`);

        if (page.url().includes('/tiktokstudio/content') || await page.locator(successSelectors).isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log("¡Éxito detectado!");
          isPublished = true;
          break;
        }

        // --- MEJORADO: Detección de aviso de restricción/violación ---
        const restrictionChecks = await Promise.all([
          page.getByText(/Content may be restricted/i).first().isVisible().catch(() => false),
          page.getByText(/Violation reason/i).first().isVisible().catch(() => false),
          page.getByText(/Unoriginal, low-quality/i).first().isVisible().catch(() => false),
          page.getByText(/Replace video/i).first().isVisible().catch(() => false),
          page.getByText(/Contenido restringido/i).first().isVisible().catch(() => false),
          page.getByText(/Motivo de la infracción/i).first().isVisible().catch(() => false)
        ]);

        if (restrictionChecks.some(isVisible => isVisible)) {
          console.log("🚨 ¡AVISO DE RESTRICCIÓN DETECTADO POR TIKTOK! Marcando como rechazado.");
          isRestricted = true;
          break;
        }

        let handledAnyPopupInThisPass = false;
        for (const text of popupKillList) {
          const btn = page.locator(`button:has-text("${text}")`).last();
          if (await btn.isVisible().catch(() => false)) {
            console.log(`¡TRAMPA DETECTADA! Botón "${text}" visible. Aniquilándolo...`);
            await btn.click({ force: true }).catch(() => { });
            await page.waitForTimeout(1500);
            handledAnyPopupInThisPass = true;
          }
        }

        if (!handledAnyPopupInThisPass) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(2000);
        }

        if (await postBtn.isVisible() && !(await postBtn.isDisabled())) {
          await postBtn.click({ timeout: 5000, force: true }).catch(() => { });
          await page.waitForTimeout(2000);
        }
      }

      if (!isPublished && !isRestricted) throw new Error("No se pudo confirmar la publicación tras 2 minutos.");

      // --- NUEVO: Manejo específico de RESTRICCIÓN ---
      if (isRestricted) {
        console.warn(`❌ TikTok rechazó el vídeo (${videoId}) por contenido restringido/originalidad.`);

        // Tomamos captura del video rechazado para pruebas
        await page.screenshot({ path: `video-restringido-${videoId}.png`, fullPage: true }).catch(() => { });

        await videoDoc.ref.update({
          status: 'rejected_by_tiktok',
          lastError: "Rechazado por TikTok: Contenido no original, baja calidad o QR."
        });

        await sendTelegramAlert(videoId, "🚨 TikTok detectó contenido restringido/no original. Vídeo descartado.", `video-restringido-${videoId}.png`);

        // Borrar de R2 si existe
        if (process.env.R2_ACCOUNT_ID && videoData.videoUrl) {
          try {
            console.log("[R2] Eliminando archivo rechazado por TikTok...");
            const s3Client = new S3Client({
              region: "auto",
              endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
              credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
              },
              forcePathStyle: true,
            });
            const videoKey = videoData.videoUrl.split('/').slice(-2).join('/');
            await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
            console.log(`[R2] Archivo ${videoKey} eliminado con éxito.`);
          } catch (r2Error) { console.error("[R2] Error al borrar el archivo rechazado:", r2Error.message); }
        }

        await fs.unlink(videoPath).catch(() => console.log("No se pudo borrar video de /tmp"));
        if (browser) await browser.close();

        // Vaciamos el retenedor para que saque OTRO vídeo distinto y continuamos el bucle de reintentos
        currentVideoDoc = null;
        if (attempt < MAX_ATTEMPTS) {
          console.log("⏳ Saltando al siguiente vídeo de la cola...");
          continue;
        } else {
          console.log("Alcanzados los máximos intentos tras rechazo.");
          process.exit(1);
        }
      }

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

      const updateData = {
        status: 'published',
        publishedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: admin.firestore.FieldValue.delete()
      };

      if (tiktokVideoId) {
        updateData.tiktokVideoId = tiktokVideoId;
      }

      await videoDoc.ref.update(updateData);

      if (process.env.R2_ACCOUNT_ID && videoData.videoUrl) {
        try {
          console.log("[R2] Iniciando eliminación del archivo original...");
          const s3Client = new S3Client({
            region: "auto",
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
              accessKeyId: process.env.R2_ACCESS_KEY_ID,
              secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
            forcePathStyle: true,
          });

          const videoKey = videoData.videoUrl.split('/').slice(-2).join('/');

          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: videoKey,
          }));
          console.log(`[R2] Archivo ${videoKey} eliminado con éxito de Cloudflare.`);
        } catch (r2Error) {
          console.error("[R2] Error al borrar el archivo (el vídeo sigue en TikTok):", r2Error.message);
        }
      }

      if (userEmail && process.env.RESEND_API_KEY) {
        console.log(`Enviando email de 'published' a ${userEmail}`);
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
        }).catch(e => console.error("Error enviando email definitivo:", e));
      }

      console.log("¡Éxito total en la publicación!");
      if (browser) await browser.close();
      process.exit(0);

    } catch (error) {
      console.error(`Error fatal en intento ${attempt}:`, error.message);
      if (page) await page.screenshot({ path: `error-pantalla-intento-${attempt}.png`, fullPage: true }).catch(() => { });

      try {
        await sendTelegramAlert(videoId || 'Unknown', error.message, `error-pantalla-intento-${attempt}.png`);
      } catch (e) {
        console.error("Fallo crítico en Telegram:", e.message);
      }

      if (videoId) {
        await db.collection('video_submissions').doc(videoId).update({
          status: 'queued_for_tiktok',
          attempts: admin.firestore.FieldValue.increment(1),
          lastError: error.message
        }).catch(e => console.error("Error actualizando estado en Firestore:", e.message));
      }

      if (browser) await browser.close().catch(() => { });

      if (attempt === MAX_ATTEMPTS) {
        console.error("Se alcanzaron los intentos máximos. Abortando script por hoy.");
        process.exit(1);
      } else {
        console.log("Reintentando con una nueva extracción de urna...");
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } // fin del for
})();
