// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Now import other modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import {
  Auth,
  configService,
  Cors,
  HttpServer,
  ProviderSession,
  Sentry as SentryConfig,
  Webhook,
} from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

// ==================== CAMPAIGN WORKER ENGINE (24/7) ====================
interface CampaignData {
  isRunning: boolean;
  currentIndex: number;
  total: number;
  successCount: number;
  failedCount: number;
  rows: any[];
  config: any;
}

let activeCampaign: CampaignData = {
  isRunning: false,
  currentIndex: 0,
  total: 0,
  successCount: 0,
  failedCount: 0,
  rows: [],
  config: null,
};

function generateRandomCode() {
  return `#${Math.floor(100000 + Math.random() * 900000)}`;
}

function generateInvisibleGhostString(length = 6) {
  const ghostChars = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'];
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ghostChars[Math.floor(Math.random() * ghostChars.length)];
  }
  return result;
}

function replacePlaceholders(template: string, row: any) {
  let result = template || '';
  result = result.replace(/@phone/gi, row.phone || '');
  result = result.replace(/@name/gi, row.name || '');
  result = result.replace(/@Randomcode/gi, generateRandomCode());
  result = result.replace(/@invisible/gi, generateInvisibleGhostString(8));
  result = result.replace(/@obj/gi, '\uFFFC' + generateInvisibleGhostString(2));

  if (row.vars) {
    for (const [key, val] of Object.entries(row.vars)) {
      result = result.replace(new RegExp(`@${key}`, 'gui'), String(val));
    }
  }
  return result;
}

async function runInternalWorker() {
  const cfg = activeCampaign.config;
  const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
  const port = configService.get<HttpServer>('SERVER').PORT || 8080;
  const baseUrl = `http://localhost:${port}`;

  while (activeCampaign.currentIndex < activeCampaign.rows.length && activeCampaign.isRunning) {
    const row = activeCampaign.rows[activeCampaign.currentIndex];

    try {
      // 1. فحص وجود الرقم على واتساب
      if (cfg.filterWhatsApp) {
        try {
          const checkRes = await axios.post(
            `${baseUrl}/chat/whatsappNumbers/${cfg.instance}`,
            { numbers: [row.phone] },
            { headers: { apikey: globalApiKey } }
          );
          if (Array.isArray(checkRes.data) && checkRes.data[0] && !checkRes.data[0].exists) {
            activeCampaign.failedCount++;
            activeCampaign.currentIndex++;
            continue;
          }
        } catch (e) {}
      }

      // 2. محاكاة الكتابة / التسجيل الصوتي
      if (cfg.simulateTyping) {
        try {
          await axios.post(
            `${baseUrl}/chat/sendPresence/${cfg.instance}`,
            {
              number: row.phone,
              presence: cfg.media?.isVoiceNote ? 'recording' : 'composing',
              delay: 1200,
            },
            { headers: { apikey: globalApiKey } }
          );
          const typeSec = Math.floor(Math.random() * 3 + 2);
          await new Promise((r) => setTimeout(r, typeSec * 1000));
        } catch (e) {}
      }

      const customMsgs = (cfg.messages || []).map((m: string) => replacePlaceholders(m, row));

      // 3. إرسال المرفقات (إن وجدت)
      if (cfg.media && cfg.media.base64) {
        const endpoint = cfg.media.isVoiceNote
          ? `${baseUrl}/message/sendWhatsAppAudio/${cfg.instance}`
          : `${baseUrl}/message/sendMedia/${cfg.instance}`;

        const payload = cfg.media.isVoiceNote
          ? { number: row.phone, audio: cfg.media.base64 }
          : {
              number: row.phone,
              mediatype: cfg.media.mimeType?.startsWith('image/') ? 'image' : 'document',
              mimetype: cfg.media.mimeType,
              caption: customMsgs[0] || '',
              media: cfg.media.base64,
              fileName: cfg.media.fileName,
            };

        await axios.post(endpoint, payload, { headers: { apikey: globalApiKey } });
        if (customMsgs.length > 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      // 4. إرسال النصوص
      for (let m = 0; m < customMsgs.length; m++) {
        if (!activeCampaign.isRunning) break;
        await axios.post(
          `${baseUrl}/message/sendText/${cfg.instance}`,
          { number: row.phone, text: customMsgs[m] },
          { headers: { apikey: globalApiKey } }
        );
        if (m < customMsgs.length - 1) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      activeCampaign.successCount++;
    } catch (err) {
      activeCampaign.failedCount++;
    }

    activeCampaign.currentIndex++;

    // 5. إدارة الفواصل الزمنية والاستراحات
    if (activeCampaign.currentIndex < activeCampaign.rows.length && activeCampaign.isRunning) {
      if (cfg.batchCount > 0 && activeCampaign.currentIndex % cfg.batchCount === 0) {
        await new Promise((r) => setTimeout(r, (cfg.batchPauseTime || 60) * 1000));
      } else {
        const minD = Number(cfg.minDelay) || 10;
        const maxD = Number(cfg.maxDelay) || 20;
        const delay = Math.floor(Math.random() * (maxD - minD + 1) + minD);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }

  activeCampaign.isRunning = false;
}
// ======================================================================

async function initWA() {
  await waMonitor.loadInstance();
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));

  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  // ==================== CAMPAIGN ROUTES ====================
  app.post('/api/campaign/start', (req: Request, res: Response) => {
    const { rows, config } = req.body;
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'قائمة الأرقام فارغة' });
    }

    activeCampaign = {
      isRunning: true,
      currentIndex: 0,
      total: rows.length,
      successCount: 0,
      failedCount: 0,
      rows,
      config,
    };

    runInternalWorker();

    return res.json({ message: 'Campaign started in background', total: rows.length });
  });

  app.get('/api/campaign/status', (req: Request, res: Response) => {
    return res.json({
      isRunning: activeCampaign.isRunning,
      currentIndex: activeCampaign.currentIndex,
      total: activeCampaign.total,
      successCount: activeCampaign.successCount,
      failedCount: activeCampaign.failedCount,
    });
  });

  app.post('/api/campaign/stop', (req: Request, res: Response) => {
    activeCampaign.isRunning = false;
    return res.json({ message: 'Campaign stopped' });
  });
  // ==========================================================

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK != '' && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000;
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const now = localISOTime;
          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: {
                message: err['message'] || 'Internal Server Error',
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          const baseURL = webhook.EVENTS.ERRORS_WEBHOOK;
          const httpService = axios.create({ baseURL });

          httpService.post('', errorData);
        }

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  eventManager.init(server);

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');
    Sentry.setupExpressErrorHandler(app);
  }

  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));

  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  onUnexpectedError();
}

bootstrap();
