import path from 'path';

export const CONFIG = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  OPENAI_MAX_RETRIES: Number(process.env.OPENAI_MAX_RETRIES ?? 5),
  WHISPER_BACKEND_URL: process.env.WHISPER_BACKEND_URL || 'http://127.0.0.1:5000',
  CAPTION_FONT: process.env.CLIP_CAPTION_FONT || 'Arial',
  CAPTION_FONTS_DIR: process.env.CLIP_CAPTION_FONTS_DIR || '',
  CAPTION_FONT_SIZE: Number(process.env.CLIP_CAPTION_FONT_SIZE ?? 96),
  CAPTION_MARGIN_V: Number(process.env.CLIP_CAPTION_MARGIN_V ?? 380),
  CAPTION_COLOUR: process.env.CLIP_CAPTION_COLOUR || '&H00FFFFFF',
  CAPTION_ACTIVE_COLOUR: process.env.CLIP_CAPTION_ACTIVE_COLOUR || '&H0000E5FF',
  CAPTION_OUTLINE: Number(process.env.CLIP_CAPTION_OUTLINE ?? 6),
  CAPTION_SHADOW: Number(process.env.CLIP_CAPTION_SHADOW ?? 3),
  WATERMARK_MODE: (process.env.CLIP_WATERMARK_MODE || 'off') as 'off' | 'crop' | 'delogo',
  WATERMARK_REGION: process.env.CLIP_WATERMARK_REGION || '0,0,0.25,0.09',
  N8N_CLIP_WEBHOOK_URL: process.env.N8N_CLIP_WEBHOOK_URL || '',
  N8N_CLIP_UPLOAD_BUDGET_MB: Number(process.env.N8N_CLIP_UPLOAD_BUDGET_MB || 90),
  N8N_CLIP_WEBHOOK_MODE: (process.env.N8N_CLIP_WEBHOOK_MODE === 'per-clip' ? 'per-clip' : 'batch') as 'batch' | 'per-clip',
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || path.join(process.cwd(), 'public', 'workspace'),
};
