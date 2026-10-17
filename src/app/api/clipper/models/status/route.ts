import { apiRoute } from '@/lib/apiRoute';
import { probeService, SERVICE_INFO } from '@/lib/serviceHealth';
import { CONFIG } from '@/lib/config';

export const GET = apiRoute('GET /api/clipper/models/status', async () => {
  // The Whisper server also hosts the YuNet face tracker — same process
  // (servers/whisper-backend/server.py), so one probe answers for both.
  const whisperOnline = await probeService(`${CONFIG.WHISPER_BACKEND_URL}/unload`);

  return {
    whisper: {
      name: SERVICE_INFO.whisper.name,
      online: whisperOnline,
      port: SERVICE_INFO.whisper.port,
      vramMode: 'Dynamic On-Demand (Auto-Unload)',
    },
    llm: {
      name: SERVICE_INFO.llm.name(),
      online: !!CONFIG.OPENAI_API_KEY,
      port: 0,
      contextSize: 128000,
    },
    mediapipe: {
      name: 'YuNet Face Tracker + FFmpeg',
      online: whisperOnline,
      type: 'Local CPU/GPU',
    },
  };
});


