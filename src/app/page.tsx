'use client';

import React, { useState } from 'react';

interface HookDetails {
  start_time: string;
  end_time: string;
  viral_score: number;
  reason_for_clip: string;
  suggested_title: string;
}

interface Clip {
  /** Published title, written by the metadata pass. */
  title: string;
  start_time: string;
  end_time: string;
  viral_score: number;
  /** The selector's internal note. Shown for review, never posted. */
  reason_for_clip: string;
  /** Published caption. */
  caption?: string;
  hashtags?: string[];
  videoUrl: string;
  cropLayout?: string;
  transcript?: string;
}

interface SystemPrompt {
  id: string;
  label: string;
  stage: string;
  model: string;
  content: string;
}

/**
 * Reads a newline-delimited JSON stream, handing each parsed object to
 * `onEvent`. Return false from `onEvent` to stop reading.
 *
 * Split out from the pipeline handler so the transport (chunk decoding,
 * partial-line buffering, malformed-line tolerance) is separate from what the
 * events mean. A chunk can end mid-line, which is why the tail is carried over
 * rather than parsed.
 */
async function readNdjsonStream(
  response: Response,
  onEvent: (data: any) => boolean | void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to open stream reader.');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        continue; // ignore malformed lines
      }
      if (onEvent(data) === false) return;
    }
  }
}

export default function ClipperDashboard() {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'error'>('idle');
  const [currentStep, setCurrentStep] = useState<string>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [hooks, setHooks] = useState<HookDetails[]>([]);
  const [renderingProgress, setRenderingProgress] = useState<{
    index: number;
    total: number;
    title: string;
    startTime?: string;
    endTime?: string;
    percent?: number;
  } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  // Parallel render: per-clip percent keyed by clip index (1-based)
  const [clipProgress, setClipProgress] = useState<Record<number, { title: string; percent: number; done: boolean }>>({});
  const [clipsTotal, setClipsTotal] = useState(0);
  const [clips, setClips] = useState<Clip[]>([]);
  const [videoid, setVideoid] = useState('');
  const [webhookStatus, setWebhookStatus] = useState<'success' | 'failed' | 'idle'>('idle');
  const [webhookMessage, setWebhookMessage] = useState('');

  const [clip1Transcript, setClip1Transcript] = useState('');
  const [clip2Transcript, setClip2Transcript] = useState('');
  const [clip3Transcript, setClip3Transcript] = useState('');

  const [clip1VideoUrl, setClip1VideoUrl] = useState('');
  const [clip2VideoUrl, setClip2VideoUrl] = useState('');
  const [clip3VideoUrl, setClip3VideoUrl] = useState('');

  const [clip1Hashtags, setClip1Hashtags] = useState('');
  const [clip2Hashtags, setClip2Hashtags] = useState('');
  const [clip3Hashtags, setClip3Hashtags] = useState('');

  const [publishStatus, setPublishStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [publishErrorMessage, setPublishErrorMessage] = useState('');

  const [clip1Title, setClip1Title] = useState('');
  const [clip2Title, setClip2Title] = useState('');
  const [clip3Title, setClip3Title] = useState('');

  const [clip1Description, setClip1Description] = useState('');
  const [clip2Description, setClip2Description] = useState('');
  const [clip3Description, setClip3Description] = useState('');

  const [selectedLayout, setSelectedLayout] = useState<'stacked' | 'center'>('stacked');
  const [forceTranscribe, setForceTranscribe] = useState<boolean>(false);
  const [useHooksCache, setUseHooksCache] = useState<boolean>(true);
  const [isTranscriptionCached, setIsTranscriptionCached] = useState<boolean>(false);

  const [activeModel, setActiveModel] = useState<'whisper' | 'llm' | 'mediapipe' | 'yt-dlp' | null>(null);
  const [activeModelAction, setActiveModelAction] = useState<string>('Ready');
  const [modelLogs, setModelLogs] = useState<Array<{ time: string; message: string; type: string }>>([
    { time: new Date().toLocaleTimeString(), message: 'System ready. Paste a YouTube URL to begin.', type: 'info' }
  ]);
  const [whisperOnline, setWhisperOnline] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [systemPrompts, setSystemPrompts] = useState<SystemPrompt[]>([]);
  const [activePromptId, setActivePromptId] = useState('viral-hooks');
  const [promptNote, setPromptNote] = useState('');
  const [promptLoadError, setPromptLoadError] = useState('');

  const addModelLog = (message: string, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setModelLogs((prev) => [{ time, message, type }, ...prev.slice(0, 19)]);
  };

  React.useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/clipper/models/status');
        if (res.ok) {
          const data = await res.json();
          setWhisperOnline(data.whisper?.online ?? false);
        }
      } catch {
        // The status badge stays offline while the optional local service is unavailable.
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 8000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const loadSystemPrompts = async () => {
      try {
        const response = await fetch('/api/prompts', { cache: 'no-store' });
        if (!response.ok) throw new Error('Prompt endpoint is unavailable.');
        const data = await response.json();
        setSystemPrompts(data.prompts || []);
        setPromptNote(data.note || '');
      } catch (error) {
        setPromptLoadError(error instanceof Error ? error.message : 'Could not load system prompts.');
      }
    };
    loadSystemPrompts();
  }, []);

  /**
   * Loads the first three finished clips into the editable fields.
   *
   * The three clips have separate state variables rather than one array, so
   * this pairs each slot's setters up and loops instead of repeating the same
   * five assignments three times.
   */
  const fillClipEditors = (finished: Clip[]) => {
    const slots = [
      { setTranscript: setClip1Transcript, setUrl: setClip1VideoUrl, setTitle: setClip1Title, setDesc: setClip1Description, setTags: setClip1Hashtags },
      { setTranscript: setClip2Transcript, setUrl: setClip2VideoUrl, setTitle: setClip2Title, setDesc: setClip2Description, setTags: setClip2Hashtags },
      { setTranscript: setClip3Transcript, setUrl: setClip3VideoUrl, setTitle: setClip3Title, setDesc: setClip3Description, setTags: setClip3Hashtags },
    ];
    slots.forEach((slot, i) => {
      const clip = finished[i];
      if (!clip) return;
      slot.setTranscript(clip.transcript || '');
      slot.setUrl(clip.videoUrl || '');
      slot.setTitle(clip.title || '');
      slot.setDesc(clip.caption || '');
      slot.setTags((clip.hashtags || []).map((t: string) => `#${t}`).join(' '));
    });
  };

  /** Resets every field the previous run left behind. */
  const resetRunState = () => {
    setStatus('processing');
    setCurrentStep('downloading-audio');
    setErrorMessage('');
    setHooks([]);
    setRenderingProgress(null);
    setDownloadProgress(null);
    setClipProgress({});
    setClipsTotal(0);
    setClips([]);
    setIsTranscriptionCached(false);
    setActiveModel('yt-dlp');
    setActiveModelAction('Downloading audio from YouTube...');
    addModelLog('🎬 Pipeline started.', 'info');
  };

  /** Every failure path lands here — a thrown error and a pipeline 'error'
   *  event were setting the same five pieces of state separately. */
  const failRun = (message: string) => {
    setStatus('error');
    setCurrentStep('error');
    setErrorMessage(message || 'Pipeline failed.');
    setActiveModel(null);
    setActiveModelAction('Error');
    addModelLog(`❌ ${message}`, 'error');
  };

  // One handler per step, looked up by name. This was a ~130-line
  // if/else chain — a map makes each step's effect readable on its own and
  // means adding a step touches one entry instead of the chain's shape.
  const buildStepHandlers = (): Record<string, (data: any) => void> => ({
    'downloading-audio': () => {
      setCurrentStep('downloading-audio');
      addModelLog('📥 Downloading audio with yt-dlp...', 'info');
    },
    transcribing: (data) => {
      setCurrentStep('transcribing');
      if (data.cached) {
        setIsTranscriptionCached(true);
        addModelLog('⚡ Cache hit — skipping Whisper.', 'info');
      } else {
        addModelLog('🎤 Whisper (large-v3) transcribing audio...', 'whisper');
      }
    },
    'whisper-unloaded': () => addModelLog('✓ Whisper done. VRAM freed.', 'unload'),
    'extracting-hooks': (data) => {
      setCurrentStep('extracting-hooks');
      addModelLog(
        data.cached ? '⚡ Cache hit — skipping OpenAI.' : '🤖 OpenAI identifying viral hooks...',
        data.cached ? 'info' : 'llm'
      );
    },
    'hooks-extracted': (data) => {
      setHooks(data.hooks || []);
      addModelLog(`✓ ${(data.hooks || []).length} viral clips identified.`, 'llm');
    },
    'downloading-segments': (data) => {
      setCurrentStep('downloading-segments');
      setActiveModel('yt-dlp');
      setDownloadProgress({ downloaded: 0, total: data.total });
      addModelLog(`📥 Downloading ${data.total} video segments in parallel...`, 'info');
    },
    'segment-downloaded': (data) => {
      setDownloadProgress((prev) => prev
        ? { ...prev, downloaded: data.index }
        : { downloaded: data.index, total: data.total });
      addModelLog(`✓ Segment ${data.index}/${data.total} downloaded (${data.startTime} – ${data.endTime})`, 'info');
    },
    'cookies-ready': (data) => {
      if (data.mode === 'browser') {
        addModelLog('🔐 Live browser cookies OK — no cookies.txt needed.', 'info');
      } else if (data.mode === 'jar') {
        addModelLog('🔐 Cookie jar in use — session tokens refreshed.', 'info');
      } else {
        addModelLog('⚠️ No cookies configured — YouTube may reject downloads.', 'error');
      }
    },
    'rendering-parallel': (data) => {
      setCurrentStep('rendering');
      setDownloadProgress(null);
      setActiveModel('mediapipe');
      setClipsTotal(data.total);
      setClipProgress({});
      addModelLog(`🎬 Rendering ${data.total} clips in parallel...`, 'render');
    },
    'clip-progress': (data) => {
      setClipProgress((prev) => ({
        ...prev,
        [data.index]: { title: data.title, percent: data.percent, done: prev[data.index]?.done ?? false },
      }));
    },
    'clip-rendered': (data) => {
      setClipProgress((prev) => ({
        ...prev,
        [data.index]: { title: data.title, percent: 100, done: true },
      }));
      addModelLog(`✓ Clip ${data.index}/${data.total} done — layout: ${data.layout}`, 'render');
    },
    'face-tracking': (data) => {
      setCurrentStep('rendering');
      setDownloadProgress(null);
      setActiveModel('mediapipe');
      setRenderingProgress({
        index: data.index, total: data.total, title: data.title,
        startTime: data.startTime, endTime: data.endTime, percent: undefined,
      });
      addModelLog(`🎯 Face tracking Clip ${data.index}/${data.total}: "${data.title}"`, 'render');
    },
    'rendering-clip': (data) => {
      setCurrentStep('rendering');
      setDownloadProgress(null);
      setRenderingProgress({
        index: data.index, total: data.total, title: data.title,
        startTime: data.startTime, endTime: data.endTime, percent: data.percent,
      });
      if (data.percent === undefined) {
        addModelLog(`🎬 Rendering Clip ${data.index}/${data.total}: "${data.title}"`, 'render');
      }
    },
    'face-tracking-unavailable': (data) => {
      addModelLog(`⚠️ Face tracking DOWN (${data.error}) — clip ${data.index} used center crop, no split.`, 'error');
    },
    heartbeat: () => { /* keepalive ping */ },
    completed: (data) => {
      setClips(data.clips || []);
      setCurrentStep('completed');
      setStatus('completed');
      setVideoid(data.videoid || '');
      setWebhookStatus(data.webhookStatus || 'idle');
      setWebhookMessage(data.webhookMessage || '');
      setActiveModel(null);
      setActiveModelAction('Done');
      addModelLog('✨ All clips ready!', 'info');
      fillClipEditors(data.clips || []);
    },
    error: (data) => {
      setStatus('error');
      setCurrentStep('error');
      setErrorMessage(data.message || 'Pipeline failed.');
      setActiveModel(null);
      setActiveModelAction('Error');
      addModelLog(`❌ ${data.message}`, 'error');
    },
  });

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!youtubeUrl.trim()) return;

    resetRunState();

    try {
      const response = await fetch('/api/clipper/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: youtubeUrl.trim(),
          cropLayout: selectedLayout,
          bypassCache: forceTranscribe,
          bypassHooksCache: !useHooksCache,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to start processing pipeline.');
      }

      const handlers = buildStepHandlers();

      await readNdjsonStream(response, (data) => {
        if (data.modelAction) setActiveModelAction(data.modelAction);
        if (data.activeModel !== undefined) setActiveModel(data.activeModel);
        handlers[data.step]?.(data);
        // 'error' is terminal — stop consuming the stream.
        return data.step !== 'error';
      });
    } catch (err: any) {
      failRun(err.message || 'Unexpected error.');
    }
  };

  const handlePublishRetry = async () => {
    setPublishStatus('loading');
    setPublishErrorMessage('');
    try {
      const response = await fetch('/api/clipper/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoid,
          clip1_transcript: clip1Transcript,
          clip2_transcript: clip2Transcript,
          clip3_transcript: clip3Transcript,
          clip1_videoUrl: clip1VideoUrl,
          clip2_videoUrl: clip2VideoUrl,
          clip3_videoUrl: clip3VideoUrl,
          clip1_title: clip1Title,
          clip2_title: clip2Title,
          clip3_title: clip3Title,
          clip1_description: clip1Description,
          clip2_description: clip2Description,
          clip3_description: clip3Description,
          clip1_hashtags: clip1Hashtags,
          clip2_hashtags: clip2Hashtags,
          clip3_hashtags: clip3Hashtags,
        }),
      });
      const resData = await response.json();
      if (!response.ok) throw new Error(resData.error || resData.details || 'Publish failed.');
      setPublishStatus('success');
      setWebhookStatus('success');
      setWebhookMessage('Webhook dispatched successfully.');
    } catch (err: any) {
      setPublishStatus('error');
      setPublishErrorMessage(err.message || 'Unexpected error.');
    }
  };

  const getStepStatus = (stepName: string) => {
    const order = ['downloading-audio', 'transcribing', 'extracting-hooks', 'rendering', 'completed'];
    const cur = order.indexOf(currentStep);
    const tgt = order.indexOf(stepName);
    if (currentStep === 'error') return 'error';
    if (cur > tgt) return 'completed';
    if (cur === tgt) return 'active';
    return 'upcoming';
  };

  const pipelineSteps = [
    { key: 'downloading-audio', label: 'Download', sub: 'yt-dlp audio', icon: '📥' },
    { key: 'transcribing',      label: 'Transcribe', sub: isTranscriptionCached ? '⚡ Cached' : 'Whisper large-v3', icon: '🎤' },
    { key: 'extracting-hooks',  label: 'AI Analysis', sub: 'OpenAI hooks', icon: '🤖' },
    { key: 'rendering',         label: 'Render',    sub: 'Download + 9:16', icon: '🎬' },
  ];

  const activeSystemPrompt =
    systemPrompts.find((prompt) => prompt.id === activePromptId) || systemPrompts[0];

  return (
    <div className="py-8 max-w-5xl mx-auto space-y-7">

      {/* ── Page Header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center shadow-lg shrink-0"
            style={{ background: 'linear-gradient(135deg, #8b5cf6 0%, #06b6d4 100%)' }}>
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4" />
            </svg>
          </div>
          <div>
            <h1 className="text-3xl font-bold leading-none tracking-tight" style={{ color: 'var(--text-main)' }}>
              Clipper<span style={{ color: 'var(--accent-purple)' }}>.AI</span>
            </h1>
            <p className="text-sm mt-1.5" style={{ color: 'var(--text-dim)' }}>
              YouTube Shorts Generator · Whisper + OpenAI + FFmpeg
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowPrompts((open) => !open)}
            aria-expanded={showPrompts}
            aria-controls="system-prompts-panel"
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-bold transition-all hover:border-violet-400/60"
            style={{
              background: showPrompts ? 'rgba(139,92,246,0.14)' : 'var(--bg-card)',
              borderColor: showPrompts ? 'rgba(139,92,246,0.55)' : 'var(--border-color)',
              color: showPrompts ? '#c4b5fd' : 'var(--text-muted)',
            }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" />
            </svg>
            AI System Prompts
          </button>

          {/* Live action badge */}
          {activeModel && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border animate-pulse"
              style={{ background: 'rgba(139,92,246,0.08)', borderColor: 'rgba(139,92,246,0.35)', color: '#a78bfa' }}>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-violet-400" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-400" />
              </span>
              <span className="text-xs font-semibold">{activeModelAction}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── System Status Bar ─────────────────────────────────── */}
      <div className="rounded-xl border"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}>
        <div className="flex items-stretch divide-x" style={{ borderColor: 'var(--border-color)' }}>
          {[
            {
              icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                </svg>
              ),
              dot: whisperOnline ? '#a78bfa' : '#ef4444',
              label: 'Whisper',
              sub: whisperOnline ? 'Online · :5000' : 'Offline',
              online: whisperOnline,
            },
            {
              icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              ),
              dot: '#34d399',
              label: 'OpenAI',
              sub: 'Cloud API',
              online: true,
            },
            {
              icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              ),
              dot: '#e879f9',
              label: 'YuNet',
              sub: 'FFmpeg ready',
              online: true,
            },
          ].map((svc, i) => (
            <div key={i} className="flex items-center gap-4 px-8 py-6 flex-1">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'var(--bg-deep)', color: svc.dot, border: '1px solid var(--border-color)' }}>
                {svc.icon}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>{svc.label}</span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: svc.dot }} />
                </div>
                <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>{svc.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Prompt Transparency Panel ───────────────────────── */}
      {showPrompts && (
        <section
          id="system-prompts-panel"
          className="rounded-xl border overflow-hidden"
          style={{ background: 'var(--bg-card)', borderColor: 'rgba(139,92,246,0.45)' }}
        >
          <div className="flex items-start justify-between gap-6 px-6 py-5 border-b"
            style={{ borderColor: 'var(--border-color)', background: 'rgba(139,92,246,0.06)' }}>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] px-2 py-1 rounded-md"
                  style={{ background: 'rgba(34,211,238,0.1)', color: 'var(--accent-cyan)' }}>
                  Prompt transparency
                </span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>read-only</span>
              </div>
              <h2 className="text-lg font-bold mt-3" style={{ color: 'var(--text-main)' }}>
                Exact instructions sent to the AI
              </h2>
              <p className="text-xs mt-1 max-w-2xl leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                These values come from the same loader used by the pipeline. No secrets or runtime transcript data are exposed.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowPrompts(false)}
              className="w-8 h-8 rounded-lg border flex items-center justify-center shrink-0"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-dim)' }}
              aria-label="Close system prompts"
            >
              ×
            </button>
          </div>

          {promptLoadError ? (
            <div className="m-6 p-4 rounded-xl text-sm"
              style={{ background: 'var(--color-error-bg)', color: 'var(--color-error)' }}>
              {promptLoadError}
            </div>
          ) : systemPrompts.length === 0 ? (
            <div className="p-8 text-sm" style={{ color: 'var(--text-dim)' }}>Loading prompts…</div>
          ) : (
            <div className="p-6">
              <div className="flex flex-wrap gap-2 mb-5">
                {systemPrompts.map((prompt) => (
                  <button
                    key={prompt.id}
                    type="button"
                    onClick={() => setActivePromptId(prompt.id)}
                    className="px-4 py-2.5 rounded-xl border text-left transition-all"
                    style={{
                      background: activeSystemPrompt?.id === prompt.id ? 'rgba(139,92,246,0.12)' : 'var(--bg-deep)',
                      borderColor: activeSystemPrompt?.id === prompt.id ? 'rgba(139,92,246,0.55)' : 'var(--border-color)',
                    }}
                  >
                    <span className="block text-xs font-bold"
                      style={{ color: activeSystemPrompt?.id === prompt.id ? '#c4b5fd' : 'var(--text-muted)' }}>
                      {prompt.label}
                    </span>
                    <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{prompt.stage}</span>
                  </button>
                ))}
              </div>

              {activeSystemPrompt && (
                <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-color)' }}>
                  <div className="flex items-center justify-between gap-4 px-4 py-3 border-b"
                    style={{ background: 'var(--bg-deep)', borderColor: 'var(--border-color)' }}>
                    <span className="text-xs font-mono" style={{ color: 'var(--accent-cyan)' }}>
                      system · {activeSystemPrompt.id}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-1 rounded-md"
                      style={{ background: 'rgba(16,185,129,0.1)', color: '#34d399' }}>
                      {activeSystemPrompt.model}
                    </span>
                  </div>
                  <pre className="m-0 p-5 max-h-[34rem] overflow-auto whitespace-pre-wrap text-[11px] leading-6"
                    style={{ background: '#060910', color: '#cbd5e1', fontFamily: 'var(--font-mono)' }}>
                    {activeSystemPrompt.content}
                  </pre>
                </div>
              )}

              {promptNote && (
                <p className="text-[11px] mt-4" style={{ color: 'var(--text-dim)' }}>{promptNote}</p>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── URL Input Card ────────────────────────────────────── */}
      <div className="rounded-xl border overflow-hidden panel-card glow-card"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}>
        <div className="p-9">
          <form onSubmit={handleGenerate} className="space-y-8">

            {/* Label + Input + Button */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-widest mb-4"
                style={{ color: 'var(--text-dim)' }}>
                YouTube Video URL
              </label>
              <div className="flex gap-4">
                <div className="relative flex-1">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"
                    style={{ color: 'var(--text-dim)' }}>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                    </svg>
                  </div>
                  <input
                    type="url"
                    required
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    disabled={status === 'processing'}
                    className="block w-full pl-11 pr-4 py-4 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none"
                    style={{
                      background: 'var(--bg-deep)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-main)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  />
                </div>
                <button
                  type="submit"
                  disabled={status === 'processing'}
                  className="px-8 py-4 rounded-xl font-bold text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-95 flex items-center gap-2 shrink-0 shadow-md"
                  style={{ background: 'linear-gradient(135deg, #8b5cf6 0%, #06b6d4 100%)' }}
                >
                  {status === 'processing' ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Processing…
                    </>
                  ) : (
                    <>
                      Generate Shorts
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Options Row */}
            <div className="grid grid-cols-2 gap-10 pt-8 border-t" style={{ borderColor: 'var(--border-color)' }}>

              {/* Crop Layout */}
              <div>
                <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--text-dim)' }}>
                  Crop Layout
                </p>
                <div className="flex gap-3">
                  {[
                    { value: 'stacked', icon: '📺', label: 'Dynamic Split' },
                    { value: 'center',  icon: '👤', label: 'Force Center' },
                  ].map(opt => (
                    <label key={opt.value}
                      className="flex items-center gap-3 cursor-pointer px-5 py-4 rounded-xl border transition-all flex-1"
                      style={{
                        background: selectedLayout === opt.value ? 'rgba(139,92,246,0.1)' : 'var(--bg-deep)',
                        borderColor: selectedLayout === opt.value ? 'rgba(139,92,246,0.5)' : 'var(--border-color)',
                      }}>
                      <input
                        type="radio"
                        name="cropLayout"
                        value={opt.value}
                        checked={selectedLayout === opt.value}
                        onChange={() => setSelectedLayout(opt.value as 'stacked' | 'center')}
                        disabled={status === 'processing'}
                        className="accent-violet-500"
                      />
                      <span className="text-sm">{opt.icon}</span>
                      <span className="text-sm font-medium" style={{ color: selectedLayout === opt.value ? '#a78bfa' : 'var(--text-muted)' }}>
                        {opt.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Cache Options */}
              <div>
                <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--text-dim)' }}>
                  Cache
                </p>
                <div className="flex flex-col gap-3">
                  {/* Whisper cache toggle */}
                  <label
                    className="flex items-center gap-3 cursor-pointer px-5 py-4 rounded-xl border transition-all"
                    style={{
                      background: !forceTranscribe ? 'rgba(6,182,212,0.06)' : 'var(--bg-deep)',
                      borderColor: !forceTranscribe ? 'rgba(6,182,212,0.4)' : 'var(--border-color)',
                      opacity: status === 'processing' ? 0.5 : 1,
                    }}>
                    {/* Custom toggle pill */}
                    <div
                      onClick={() => status !== 'processing' && setForceTranscribe(f => !f)}
                      style={{
                        width: 40, height: 22, borderRadius: 11, flexShrink: 0,
                        background: !forceTranscribe ? 'var(--accent-cyan)' : 'var(--border-color)',
                        position: 'relative', transition: 'background 0.2s', cursor: 'pointer',
                      }}>
                      <div style={{
                        width: 16, height: 16, borderRadius: '50%', background: '#fff',
                        position: 'absolute', top: 3,
                        left: !forceTranscribe ? 21 : 3,
                        transition: 'left 0.2s',
                      }} />
                    </div>
                    <span className="text-base">🎙️</span>
                    <div>
                      <p className="text-sm font-semibold" style={{ color: !forceTranscribe ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                        Whisper cache
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                        Skip transcription if already done
                      </p>
                    </div>
                  </label>

                  {/* OpenAI hooks cache toggle */}
                  <label
                    className="flex items-center gap-3 cursor-pointer px-5 py-4 rounded-xl border transition-all"
                    style={{
                      background: useHooksCache ? 'rgba(139,92,246,0.06)' : 'var(--bg-deep)',
                      borderColor: useHooksCache ? 'rgba(139,92,246,0.4)' : 'var(--border-color)',
                      opacity: status === 'processing' ? 0.5 : 1,
                    }}>
                    <div
                      onClick={() => status !== 'processing' && setUseHooksCache(h => !h)}
                      style={{
                        width: 40, height: 22, borderRadius: 11, flexShrink: 0,
                        background: useHooksCache ? 'var(--accent-purple)' : 'var(--border-color)',
                        position: 'relative', transition: 'background 0.2s', cursor: 'pointer',
                      }}>
                      <div style={{
                        width: 16, height: 16, borderRadius: '50%', background: '#fff',
                        position: 'absolute', top: 3,
                        left: useHooksCache ? 21 : 3,
                        transition: 'left 0.2s',
                      }} />
                    </div>
                    <span className="text-base">🤖</span>
                    <div>
                      <p className="text-sm font-semibold" style={{ color: useHooksCache ? 'var(--accent-purple)' : 'var(--text-muted)' }}>
                        AI hooks cache
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                        Skip OpenAI if hooks already extracted
                      </p>
                    </div>
                  </label>
                </div>
              </div>

            </div>
          </form>
        </div>
      </div>

      {/* ── Pipeline Progress ─────────────────────────────────── */}
      {status === 'processing' && (
        <div className="rounded-xl border p-6"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}>

          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--accent-purple)' }} />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: 'var(--accent-purple)' }} />
            </span>
            <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>Processing Pipeline</h2>
            <span className="ml-auto text-xs font-mono px-2.5 py-1 rounded-lg"
              style={{ background: 'var(--bg-deep)', color: 'var(--text-dim)', border: '1px solid var(--border-color)' }}>
              {activeModelAction}
            </span>
          </div>

          {/* Steps with connecting lines */}
          <div className="relative flex items-start gap-0 mb-6">
            {pipelineSteps.map((step, idx) => {
              const s = getStepStatus(step.key);
              const isLast = idx === pipelineSteps.length - 1;
              return (
                <React.Fragment key={step.key}>
                  <div className="flex flex-col items-center flex-1 text-center px-2">
                    <div className="w-11 h-11 rounded-full flex items-center justify-center text-xl border-2 mb-2 transition-all duration-300"
                      style={{
                        background: s === 'active' ? 'rgba(139,92,246,0.2)' : s === 'completed' ? 'rgba(16,185,129,0.15)' : 'var(--bg-deep)',
                        borderColor: s === 'active' ? '#8b5cf6' : s === 'completed' ? '#10b981' : 'var(--border-color)',
                        transform: s === 'active' ? 'scale(1.1)' : 'scale(1)',
                        boxShadow: s === 'active' ? '0 0 16px rgba(139,92,246,0.35)' : 'none',
                      }}>
                      {s === 'completed' ? (
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="#10b981" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : step.icon}
                    </div>
                    <span className="text-xs font-bold"
                      style={{ color: s === 'active' ? '#a78bfa' : s === 'completed' ? '#10b981' : 'var(--text-dim)' }}>
                      {step.label}
                    </span>
                    <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{step.sub}</span>
                  </div>
                  {!isLast && (
                    <div className="flex-shrink-0 mt-5 h-[2px] w-8 self-start"
                      style={{
                        background: getStepStatus(pipelineSteps[idx + 1].key) !== 'upcoming' || s === 'completed'
                          ? 'linear-gradient(90deg, #10b981, #8b5cf6)'
                          : 'var(--border-color)',
                        marginTop: '22px',
                      }} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Download progress bar */}
          {downloadProgress && (
            <div className="rounded-xl border p-4 mb-4"
              style={{ background: 'var(--bg-deep)', borderColor: 'rgba(6,182,212,0.3)' }}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan)' }}>
                  📥 Downloading segments
                </span>
                <span className="text-xs font-mono font-bold" style={{ color: 'var(--accent-cyan)' }}>
                  {downloadProgress.downloaded} / {downloadProgress.total}
                </span>
              </div>
              {/* Segment dots */}
              <div className="flex gap-1.5 mb-3">
                {Array.from({ length: downloadProgress.total }).map((_, i) => (
                  <div
                    key={i}
                    className="flex-1 h-2 rounded-full transition-all duration-300"
                    style={{
                      background: i < downloadProgress.downloaded
                        ? 'var(--accent-cyan)'
                        : i === downloadProgress.downloaded
                          ? 'rgba(6,182,212,0.4)'
                          : 'var(--border-color)',
                    }}
                  />
                ))}
              </div>
              {/* Progress bar */}
              <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-card)' }}>
                <div
                  className="h-1 rounded-full transition-all duration-500"
                  style={{
                    width: `${(downloadProgress.downloaded / downloadProgress.total) * 100}%`,
                    background: 'linear-gradient(90deg, #06b6d4, #8b5cf6)',
                  }}
                />
              </div>
              <p className="text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>
                {downloadProgress.downloaded === downloadProgress.total
                  ? '✓ All segments downloaded'
                  : `${downloadProgress.total - downloadProgress.downloaded} remaining...`}
              </p>
            </div>
          )}

          {/* Parallel render progress — one bar per clip */}
          {currentStep === 'rendering' && clipsTotal > 0 && (
            <div className="rounded-xl border p-4 mb-4"
              style={{ background: 'var(--bg-deep)', borderColor: 'rgba(139,92,246,0.3)' }}>
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-semibold" style={{ color: 'var(--accent-purple)' }}>
                  🎬 Rendering {clipsTotal} clips in parallel
                </span>
                <span className="text-xs font-mono font-bold" style={{ color: 'var(--accent-purple)' }}>
                  {Object.values(clipProgress).filter(c => c.done).length} / {clipsTotal}
                </span>
              </div>
              <div className="space-y-2.5">
                {Array.from({ length: clipsTotal }).map((_, idx) => {
                  const i = idx + 1;
                  const c = clipProgress[i];
                  const pct = c?.percent ?? 0;
                  const done = c?.done ?? false;
                  return (
                    <div key={i}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[11px] truncate pr-3" style={{ color: 'var(--text-muted)' }}>
                          {done ? '✓' : '•'} Clip {i}
                          {c?.title ? ` — ${c.title}` : ''}
                        </span>
                        <span className="text-[11px] font-mono shrink-0"
                          style={{ color: done ? 'var(--accent-cyan)' : 'var(--text-dim)' }}>
                          {done ? 'done' : pct > 0 ? `${pct}%` : 'face tracking...'}
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-card)' }}>
                        <div
                          className={`h-1.5 rounded-full transition-all duration-300 ${pct === 0 && !done ? 'animate-pulse' : ''}`}
                          style={{
                            width: done ? '100%' : pct > 0 ? `${pct}%` : '15%',
                            background: done
                              ? 'var(--accent-cyan)'
                              : 'linear-gradient(90deg, #8b5cf6, #06b6d4)',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legacy single-clip render bar (kept for non-parallel paths) */}
          {currentStep === 'rendering' && clipsTotal === 0 && renderingProgress && (
            <div className="rounded-xl border p-4 mb-4"
              style={{
                background: 'var(--bg-deep)',
                borderColor: renderingProgress.percent === undefined ? 'rgba(139,92,246,0.35)' : 'var(--border-color)'
              }}>
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
                  {renderingProgress.percent === undefined ? '🎯 Face tracking' : '🎬 Encoding'}&nbsp;
                  clip {renderingProgress.index}/{renderingProgress.total}
                  {renderingProgress.percent !== undefined && (
                    <span className="ml-2 font-mono" style={{ color: 'var(--accent-purple)' }}>
                      {renderingProgress.percent}%
                    </span>
                  )}
                  {renderingProgress.percent === undefined && (
                    <span className="ml-2 animate-pulse text-[11px]" style={{ color: 'var(--accent-purple)' }}>
                      analyzing faces...
                    </span>
                  )}
                </span>
                {renderingProgress.startTime && (
                  <span className="text-[11px] font-mono" style={{ color: 'var(--text-dim)' }}>
                    {renderingProgress.startTime} – {renderingProgress.endTime}
                  </span>
                )}
              </div>
              <p className="text-xs font-bold mb-2 truncate" style={{ color: 'var(--text-main)' }}>
                &ldquo;{renderingProgress.title}&rdquo;
              </p>
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-card)' }}>
                <div
                  className={`h-1.5 rounded-full transition-all duration-300 ${renderingProgress.percent === undefined ? 'animate-pulse' : ''}`}
                  style={{
                    width: renderingProgress.percent !== undefined
                      ? `${renderingProgress.percent}%`
                      : `${((renderingProgress.index - 0.5) / renderingProgress.total) * 100}%`,
                    background: 'linear-gradient(90deg, #8b5cf6, #06b6d4)',
                  }}
                />
              </div>
            </div>
          )}

          {/* Hooks preview */}
          {hooks.length > 0 && currentStep !== 'completed' && (
            <div className="mb-4">
              <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>
                Viral Clips Identified ({hooks.length})
              </p>
              <div className="space-y-1.5">
                {hooks.map((h, i) => (
                  <div key={i} className="flex justify-between items-center rounded-xl px-3 py-2.5 text-xs border"
                    style={{ background: 'var(--bg-deep)', borderColor: 'var(--border-color)' }}>
                    <div className="flex items-center gap-2 truncate pr-4">
                      <span className="font-black shrink-0" style={{ color: 'var(--accent-purple)' }}>#{i + 1}</span>
                      <span className="font-medium truncate" style={{ color: 'var(--text-main)' }}>{h.suggested_title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono" style={{ color: 'var(--text-dim)' }}>{h.start_time} – {h.end_time}</span>
                      <span className="font-bold px-1.5 py-0.5 rounded text-amber-400 bg-amber-950/40 border border-amber-900/50">
                        ★ {h.viral_score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Event log */}
          <div className="rounded-xl border p-3"
            style={{ background: 'var(--bg-deep)', borderColor: 'var(--border-color)', fontFamily: 'var(--font-mono)' }}>
            <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>Event Log</p>
            <div className="space-y-1 max-h-24 overflow-y-auto text-[11px]">
              {modelLogs.slice(0, 8).map((log, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-dim)' }}>[{log.time}]</span>
                  <span style={{
                    color: log.type === 'whisper' ? '#c084fc'
                         : log.type === 'llm'     ? '#22d3ee'
                         : log.type === 'render'  ? '#e879f9'
                         : log.type === 'unload'  ? '#34d399'
                         : log.type === 'error'   ? '#f87171'
                         : 'var(--text-muted)',
                  }}>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────── */}
      {status === 'error' && (
        <div className="rounded-xl border p-5 flex gap-4"
          style={{ background: 'var(--color-error-bg)', borderColor: 'rgba(239,68,68,0.3)' }}>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-sm text-red-400 mb-1">Pipeline Failed</h3>
            <p className="text-xs text-red-300/80 leading-relaxed">{errorMessage}</p>
            <button onClick={() => setStatus('idle')} className="mt-2 text-xs text-red-400 hover:text-red-300 underline">
              Clear &amp; try again
            </button>
          </div>
        </div>
      )}

      {/* ── N8N Publish Panel ─────────────────────────────────── */}
      {clips.length > 0 && (
        <div className="rounded-xl border overflow-hidden"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}>

          {/* Panel header */}
          <div className="flex justify-between items-center px-6 py-4 border-b"
            style={{ background: 'var(--bg-deep)', borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.25)', color: 'var(--accent-cyan)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>Publish to N8N</h3>
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Review clip data before dispatching to webhook</p>
              </div>
            </div>
            {webhookStatus === 'success' ? (
              <span className="text-xs font-bold px-3 py-1 rounded-full"
                style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)', border: '1px solid rgba(16,185,129,0.3)' }}>
                ✓ Published
              </span>
            ) : webhookStatus === 'failed' ? (
              <span className="text-xs font-bold px-3 py-1 rounded-full"
                style={{ background: 'var(--color-error-bg)', color: 'var(--color-error)', border: '1px solid rgba(239,68,68,0.3)' }}>
                ✗ Failed
              </span>
            ) : (
              <span className="text-xs font-bold px-3 py-1 rounded-full"
                style={{ background: 'var(--bg-card)', color: 'var(--text-dim)', border: '1px solid var(--border-color)' }}>
                Pending
              </span>
            )}
          </div>

          <div className="p-6 space-y-5">
            {webhookMessage && (
              <div className="text-xs p-3 rounded-xl font-mono"
                style={{
                  background: webhookStatus === 'success' ? 'var(--color-success-bg)' : 'var(--color-error-bg)',
                  border: `1px solid ${webhookStatus === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  color: webhookStatus === 'success' ? '#34d399' : '#f87171',
                }}>
                {webhookMessage}
              </div>
            )}

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>Video ID</label>
              <input
                type="text"
                value={videoid}
                onChange={(e) => setVideoid(e.target.value)}
                className="block w-full px-3 py-2.5 rounded-xl text-sm font-mono focus:outline-none"
                style={{ background: 'var(--bg-deep)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { num: 1, title: clip1Title, setTitle: setClip1Title, desc: clip1Description, setDesc: setClip1Description, tags: clip1Hashtags, setTags: setClip1Hashtags, transcript: clip1Transcript, setTranscript: setClip1Transcript, url: clip1VideoUrl },
                { num: 2, title: clip2Title, setTitle: setClip2Title, desc: clip2Description, setDesc: setClip2Description, tags: clip2Hashtags, setTags: setClip2Hashtags, transcript: clip2Transcript, setTranscript: setClip2Transcript, url: clip2VideoUrl },
                { num: 3, title: clip3Title, setTitle: setClip3Title, desc: clip3Description, setDesc: setClip3Description, tags: clip3Hashtags, setTags: setClip3Hashtags, transcript: clip3Transcript, setTranscript: setClip3Transcript, url: clip3VideoUrl },
              ].map(c => (
                <div key={c.num} className="rounded-xl border p-4 space-y-3"
                  style={{ background: 'var(--bg-deep)', borderColor: 'var(--border-color)' }}>
                  <div className="flex justify-between items-center pb-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
                    <span className="text-xs font-bold" style={{ color: 'var(--accent-cyan)' }}>Clip {c.num}</span>
                    {c.url && <span className="text-[10px] font-mono truncate max-w-[90px]" style={{ color: 'var(--text-dim)' }}>{c.url}</span>}
                  </div>
                  {[
                    { label: 'Title', value: c.title, set: c.setTitle, rows: 2 },
                    { label: 'Caption', value: c.desc, set: c.setDesc, rows: 3 },
                    { label: 'Hashtags', value: c.tags, set: c.setTags, rows: 2 },
                    { label: 'Transcript', value: c.transcript, set: c.setTranscript, rows: 2 },
                  ].map(field => (
                    <div key={field.label}>
                      <label className="block text-[10px] font-bold mb-1.5 uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>{field.label}</label>
                      <textarea
                        rows={field.rows}
                        value={field.value}
                        onChange={(e) => field.set(e.target.value)}
                        className="block w-full px-2.5 py-1.5 rounded-lg text-xs leading-relaxed focus:outline-none resize-none"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', fontFamily: field.label === 'Transcript' ? 'var(--font-mono)' : 'inherit' }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
              <div className="text-xs">
                {publishStatus === 'success' && <span className="text-green-400 font-semibold">✓ Published successfully</span>}
                {publishStatus === 'error' && <span className="text-red-400 font-semibold">✗ {publishErrorMessage}</span>}
              </div>
              <button
                onClick={handlePublishRetry}
                disabled={publishStatus === 'loading'}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 flex items-center gap-2 transition-all active:scale-95 shadow-md"
                style={{ background: 'linear-gradient(135deg, #4f46e5 0%, #8b5cf6 100%)' }}
              >
                {publishStatus === 'loading' ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Publishing…
                  </>
                ) : (
                  <>
                    Dispatch to N8N
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 6.571M12 8v4l3 3" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Generated Clips Grid ──────────────────────────────── */}
      {clips.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-5 pb-4 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <div>
              <h2 className="text-base font-bold" style={{ color: 'var(--text-main)' }}>Generated Clips</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>Vertical 9:16 shorts with burned-in subtitles</p>
            </div>
            <span className="text-xs font-semibold px-3 py-1 rounded-full border"
              style={{ background: 'rgba(139,92,246,0.08)', borderColor: 'rgba(139,92,246,0.3)', color: '#a78bfa' }}>
              {clips.length} clips ready
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {clips.map((clip, index) => (
              <div key={index} className="rounded-xl border flex flex-col transition-all duration-300 hover:border-violet-500/40 overflow-hidden"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}>

                {/* Video player — 9:16 */}
                <div className="aspect-[9/16] w-full max-w-[180px] mx-auto mt-4 rounded-xl overflow-hidden border relative shadow-lg"
                  style={{ borderColor: 'var(--border-color)', background: '#000' }}>
                  <video src={clip.videoUrl} controls preload="metadata" className="w-full h-full object-cover" />
                  <div className="absolute top-2 right-2">
                    <span className="text-xs font-black text-amber-300 px-2 py-0.5 rounded-lg backdrop-blur-sm"
                      style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid rgba(245,158,11,0.4)' }}>
                      ★ {clip.viral_score}/10
                    </span>
                  </div>
                  {clip.cropLayout && (
                    <div className="absolute top-2 left-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded backdrop-blur-sm"
                        style={{ background: 'rgba(0,0,0,0.75)', color: '#a5b4fc', border: '1px solid rgba(139,92,246,0.3)' }}>
                        {clip.cropLayout === 'stacked' ? '📺 Split' : '👤 Center'}
                      </span>
                    </div>
                  )}
                </div>

                <div className="p-4 flex flex-col flex-1">
                  <h3 className="font-bold text-sm mb-1 leading-snug" style={{ color: 'var(--text-main)' }}>{clip.title}</h3>
                  <p className="text-xs font-mono mb-3" style={{ color: 'var(--text-dim)' }}>{clip.start_time} – {clip.end_time}</p>
                  <p className="text-xs mb-4 leading-relaxed italic flex-1 px-3 py-2 rounded-lg"
                    style={{ color: 'var(--text-dim)', background: 'var(--bg-deep)', border: '1px solid var(--border-color)' }}>
                    &ldquo;{clip.reason_for_clip}&rdquo;
                  </p>

                  <a
                    href={clip.videoUrl}
                    download={`short_${index + 1}.mp4`}
                    className="w-full py-2.5 rounded-xl text-center text-sm font-semibold transition-all flex items-center justify-center gap-2 hover:brightness-110"
                    style={{ background: 'var(--bg-deep)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download MP4
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


