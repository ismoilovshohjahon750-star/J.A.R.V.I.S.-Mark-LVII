import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Clipboard,
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  Monitor,
  Play,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sliders,
  Square,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { ChamferPanel } from './components/ChamferPanel';
import { AssistantState, HudCanvas } from './components/HudCanvas';
import {
  CustomizeOverlay,
  EngineOverlay,
  MemoryOverlay,
  RemoteFilePreviewData,
  RemoteFileViewerOverlay,
  RemoteOverlay,
  RemoteServerStatusData,
  ServerNodeOverlay,
} from './components/Overlays';
import { RingGauge, Sparkline } from './components/RingGauge';
import { BackgroundTask, RoutineItem, useJarvisData } from './hooks/useJarvisData';
import {
  ACCENT_PRESETS,
  PALETTE_DEFAULTS,
  applyPaletteToDocument,
  derivePalette,
} from './lib/theme';

interface TelemetrySnap {
  cpu: number;
  mem: number;
  heap: number;
  temp: number;
  netKB: number;
  uptimeSeconds: number;
  platform: string;
  cores: number;
}

interface ContentPanelState {
  title: string;
  body: string;
  sources?: Array<{ uri: string; title: string }>;
}

interface AttachedFile {
  name: string;
  size: number;
  mimeType: string;
  base64?: string;
  text?: string;
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default function App() {
  const {
    user,
    authReady,
    dbOnline,
    authError,
    profile,
    messages,
    memories,
    tasks,
    routines,
    monitors,
    signIn,
    logout,
    updateProfileSettings,
    addMessage,
    addMemory,
    removeMemory,
    createTask,
    finishTask,
    createRoutine,
    toggleRoutine,
    createMonitor,
    removeMonitor,
  } = useJarvisData();

  const assistantName = profile?.assistantName || 'J.A.R.V.I.S';
  const userName = profile?.userName || 'Sir';
  const hudStyle = profile?.hudStyle || 'face';
  const accentColor = profile?.accentColor || '#00d4ff';
  const voiceName = profile?.voiceName || 'Charon';

  const palette = useMemo(() => derivePalette(accentColor), [accentColor]);

  useEffect(() => {
    applyPaletteToDocument(palette);
  }, [palette]);

  // Clock
  const [clockStr, setClockStr] = useState('00:00:00');
  const [dateStr, setDateStr] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClockStr(now.toTimeString().slice(0, 8));
      setDateStr(
        now.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).toUpperCase()
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Live server telemetry
  const [telemetry, setTelemetry] = useState<TelemetrySnap>({
    cpu: 14,
    mem: 38,
    heap: 26,
    temp: 44,
    netKB: 42,
    uptimeSeconds: 0,
    platform: 'Linux x64',
    cores: 4,
  });
  const [netHistory, setNetHistory] = useState<number[]>([24, 30, 28, 35, 31, 42]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/telemetry');
        if (!res.ok) return;
        const data = (await res.json()) as TelemetrySnap;
        if (!alive) return;
        setTelemetry(data);
        setNetHistory((prev) => [...prev.slice(-23), data.netKB]);
      } catch {
        // Ignore transient poll errors
      }
    };
    poll();
    const id = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // HUD / Assistant state
  const [assistantState, setAssistantState] = useState<AssistantState>('STANDBY');
  const [micActive, setMicActive] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // Panels & Drawers
  const [leftTab, setLeftTab] = useState<'tasks' | 'routines'>('tasks');
  const [setupOpen, setSetupOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<
    null | 'customize' | 'memory' | 'remote' | 'engine' | 'server'
  >(null);
  const [contentPanel, setContentPanel] = useState<ContentPanelState | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteServerStatusData | null>(null);
  const [remoteFileViewer, setRemoteFileViewer] = useState<RemoteFilePreviewData | null>(null);

  const openRemoteFileInHud = useCallback(
    async (
      targetPath: string,
      presetPreview?: RemoteFilePreviewData,
      launchResult?: RemoteFilePreviewData['launchResult']
    ) => {
      if (presetPreview) {
        setRemoteFileViewer({ ...presetPreview, launchResult: launchResult ?? presetPreview.launchResult });
        return;
      }
      try {
        const res = await fetch(`/api/server/files/preview?path=${encodeURIComponent(targetPath)}`);
        const data = (await res.json()) as RemoteFilePreviewData & { error?: string };
        if (!res.ok) throw new Error(data.error || 'Failed to preview remote file.');
        setRemoteFileViewer({ ...data, launchResult });
      } catch (err) {
        await addMessage(
          'system',
          `File open error: ${err instanceof Error ? err.message : 'failed'}`,
          'sys'
        );
      }
    },
    [addMessage]
  );

  useEffect(() => {
    let alive = true;
    const pollRemote = async () => {
      try {
        const res = await fetch('/api/server/status');
        if (!res.ok) return;
        const data = (await res.json()) as RemoteServerStatusData;
        if (alive) setRemoteStatus(data);
      } catch {
        // Ignore transient network errors
      }
    };
    pollRemote();
    const id = setInterval(pollRemote, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Attachments, Camera, Search & Clipboard
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'search' | 'news' | 'research' | 'price' | 'compare'>('search');
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardText, setClipboardText] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRafRef = useRef<number>(0);
  const recognitionRef = useRef<unknown>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (analyserRafRef.current) {
      cancelAnimationFrame(analyserRafRef.current);
      analyserRafRef.current = 0;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setAudioLevel(0);
    setAssistantState(micActive ? 'LISTENING' : 'STANDBY');
  }, [micActive]);

  const speakResponse = useCallback(
    async (text: string) => {
      if (!voiceEnabled || !text.trim()) return;
      stopSpeaking();
      setAssistantState('SPEAKING');

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 2000), voiceName }),
        });
        if (!res.ok) throw new Error('TTS unavailable');
        const data = (await res.json()) as { audioBase64?: string };
        if (!data.audioBase64) throw new Error('Empty TTS');

        const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
        audioRef.current = audio;

        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioContextCtor) {
          if (!audioCtxRef.current) audioCtxRef.current = new AudioContextCtor();
          const ctx = audioCtxRef.current;
          if (ctx.state === 'suspended') await ctx.resume();
          const src = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          analyser.connect(ctx.destination);
          const buf = new Uint8Array(analyser.frequencyBinCount);

          const pump = () => {
            if (audio.paused || audio.ended) {
              setAudioLevel(0);
              return;
            }
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
            setAudioLevel(rms);
            analyserRafRef.current = requestAnimationFrame(pump);
          };
          audio.onplay = () => {
            analyserRafRef.current = requestAnimationFrame(pump);
          };
        }

        audio.onended = () => {
          setAudioLevel(0);
          setAssistantState(micActive ? 'LISTENING' : 'STANDBY');
        };
        await audio.play();
      } catch {
        // Fallback to browser SpeechSynthesis
        if ('speechSynthesis' in window) {
          const utt = new SpeechSynthesisUtterance(text.slice(0, 600));
          utt.onend = () => {
            setAudioLevel(0);
            setAssistantState(micActive ? 'LISTENING' : 'STANDBY');
          };
          setAudioLevel(0.45);
          window.speechSynthesis.speak(utt);
        } else {
          setAssistantState('STANDBY');
        }
      }
    },
    [voiceEnabled, voiceName, stopSpeaking, micActive]
  );

  // Execute autonomous background task
  const runBackgroundTask = useCallback(
    async (title: string, prompt: string, agent: 'general' | 'researcher' = 'researcher') => {
      const taskId = await createTask(title, prompt, agent);
      if (!taskId) return;
      try {
        const res = await fetch('/api/task/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, prompt, agent }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Task failed');
        await finishTask(taskId, 'done', data.result || '', data.steps || ['Completed']);
        await addMessage('system', `Background task completed: ${title}`, 'task');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Task failed';
        await finishTask(taskId, 'failed', msg, ['Task encountered an error']);
      }
    },
    [createTask, finishTask, addMessage]
  );

  // Send message to Mark-XXX Gemini Core
  const sendCommand = useCallback(
    async (overrideText?: string, visionImage?: { base64: string; mimeType: string; label: string }) => {
      const text = (overrideText ?? input).trim();
      if ((!text && !attachedFile && !visionImage) || busy || !user) return;

      const userPrompt = text || (visionImage ? `Analyze this ${visionImage.label} frame.` : `Process attached file: ${attachedFile?.name}`);
      if (!overrideText) setInput('');
      setBusy(true);
      setAssistantState('THINKING');

      const currentAttachment = attachedFile;
      setAttachedFile(null);

      await addMessage('user', userPrompt, visionImage ? visionImage.label : 'hud');

      try {
        const payload = {
          message: userPrompt,
          history: messages.slice(-14).map((m) => ({ role: m.role, text: m.text })),
          assistantName,
          userName,
          memories: memories.map((m) => ({ category: m.category, key: m.key, content: m.content })),
          routines: routines.map((r) => ({ name: r.name, scheduleText: r.scheduleText, enabled: r.enabled })),
          tasks: tasks.map((t) => ({ title: t.title, status: t.status })),
          imageBase64: visionImage?.base64 || currentAttachment?.base64,
          imageMimeType: visionImage?.mimeType || (currentAttachment?.base64 ? currentAttachment.mimeType : undefined),
          fileName: currentAttachment?.name,
          fileText: currentAttachment?.text,
        };

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Neural core error');

        const reply = String(data.text || 'Command acknowledged.');
        await addMessage('assistant', reply, 'gemini');

        // Execute returned Mark-XXX tool actions into Firestore / HUD
        const actions = Array.isArray(data.actions) ? data.actions : [];
        for (const act of actions) {
          const args = act.args || {};
          if (act.name === 'save_memory') {
            await addMemory(
              (args.category as 'fact') || 'fact',
              String(args.key || 'note'),
              String(args.content || '')
            );
          } else if (act.name === 'start_background_task') {
            void runBackgroundTask(
              String(args.title || 'Autonomous Task'),
              String(args.prompt || userPrompt),
              args.agent === 'general' ? 'general' : 'researcher'
            );
          } else if (act.name === 'create_routine') {
            await createRoutine({
              name: String(args.name || 'Custom Routine'),
              kind: (args.kind as 'prompt') || 'prompt',
              triggerType: (args.triggerType as 'time') || 'time',
              scheduleText: String(args.scheduleText || 'Daily'),
              text: String(args.text || ''),
            });
          } else if (act.name === 'create_monitor') {
            await createMonitor(
              String(args.topic || ''),
              (args.frequency as 'daily') || 'daily'
            );
          } else if (act.name === 'show_content_panel') {
            setContentPanel({
              title: String(args.title || 'DYNAMIC BRIEFING'),
              body: String(args.body || ''),
              sources: data.sources,
            });
          } else if (act.name === 'server_status') {
            setRemoteStatus(args as unknown as RemoteServerStatusData);
          } else if (act.name === 'open_remote_file' && args.path) {
            void openRemoteFileInHud(
              String(args.path),
              args.preview as RemoteFilePreviewData | undefined,
              args.launchResult as RemoteFilePreviewData['launchResult'] | undefined
            );
          } else if (act.name === 'download_remote_file' && args.path) {
            const targetPath = String(args.path);
            void (async () => {
              try {
                const dlRes = await fetch(`/api/server/files/download?path=${encodeURIComponent(targetPath)}`);
                if (!dlRes.ok) throw new Error('Remote file download failed.');
                const blob = await dlRes.blob();
                const objUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objUrl;
                a.download = targetPath.split(/[\\/]/).pop() || 'download';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(objUrl);
              } catch (dlErr) {
                await addMessage(
                  'system',
                  `Download error: ${dlErr instanceof Error ? dlErr.message : 'failed'}`,
                  'sys'
                );
              }
            })();
          }
        }

        if (Array.isArray(data.sources) && data.sources.length > 0 && !actions.some((a: { name: string }) => a.name === 'show_content_panel')) {
          setContentPanel({
            title: 'GROUNDED BRIEFING',
            body: reply,
            sources: data.sources,
          });
        }

        await speakResponse(reply);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Request failed.';
        await addMessage('system', `Error: ${msg}`, 'sys');
        setAssistantState(micActive ? 'LISTENING' : 'STANDBY');
      } finally {
        setBusy(false);
      }
    },
    [
      input,
      attachedFile,
      busy,
      user,
      messages,
      assistantName,
      userName,
      memories,
      routines,
      tasks,
      addMessage,
      addMemory,
      runBackgroundTask,
      createRoutine,
      createMonitor,
      speakResponse,
      micActive,
    ]
  );

  // Microphone / Web Speech Recognition
  const toggleMic = useCallback(() => {
    if (micActive) {
      try {
        (recognitionRef.current as { stop?: () => void } | null)?.stop?.();
      } catch {
        // ignore
      }
      setMicActive(false);
      setAssistantState('STANDBY');
      return;
    }

    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => unknown }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;

    if (!SpeechRec) {
      void addMessage('system', 'Browser speech recognition is unavailable here. Use text input or file upload.', 'sys');
      return;
    }

    const rec = new SpeechRec() as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: (ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
      onerror: () => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    };
    rec.continuous = !profile?.pushToTalk;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (ev) => {
      const last = ev.results[ev.results.length - 1];
      if (last && last[0]?.transcript) {
        const spoken = last[0].transcript.trim();
        if (spoken) void sendCommand(spoken);
      }
    };
    rec.onerror = () => {
      setMicActive(false);
      setAssistantState('STANDBY');
    };
    rec.onend = () => {
      setMicActive(false);
      setAssistantState('STANDBY');
    };
    recognitionRef.current = rec;
    rec.start();
    setMicActive(true);
    setAssistantState('LISTENING');
  }, [micActive, profile?.pushToTalk, addMessage, sendCommand]);

  // Keyboard shortcuts matching Mark-XXX: F4 (mute/mic), F11 (fullscreen), ESC (interrupt)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault();
        toggleMic();
      } else if (e.key === 'Escape') {
        stopSpeaking();
        setSetupOpen(false);
        setControlsOpen(false);
      } else if (e.key === 'F11') {
        e.preventDefault();
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.().catch(() => {});
        } else {
          document.exitFullscreen?.().catch(() => {});
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMic, stopSpeaking]);

  // Camera Vision
  const toggleCamera = async () => {
    if (cameraOpen) {
      camStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      camStreamRef.current = null;
      setCameraOpen(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      camStreamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 60);
    } catch {
      await addMessage('system', 'Camera permission denied or unavailable.', 'sys');
    }
  };

  const captureCameraFrame = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const c = document.createElement('canvas');
    c.width = vid.videoWidth || 640;
    c.height = vid.videoHeight || 480;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(vid, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.82);
    const base64 = dataUrl.split(',')[1];
    void sendCommand('Describe what you see on my webcam.', {
      base64,
      mimeType: 'image/jpeg',
      label: 'webcam',
    });
  };

  const captureScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const vid = document.createElement('video');
      vid.srcObject = stream;
      await vid.play();
      const c = document.createElement('canvas');
      c.width = vid.videoWidth || 1280;
      c.height = vid.videoHeight || 720;
      c.getContext('2d')?.drawImage(vid, 0, 0, c.width, c.height);
      stream.getTracks().forEach((tr) => tr.stop());
      const base64 = c.toDataURL('image/jpeg', 0.82).split(',')[1];
      void sendCommand('Analyze what is currently visible on my screen capture.', {
        base64,
        mimeType: 'image/jpeg',
        label: 'screen capture',
      });
    } catch {
      await addMessage('system', 'Screen capture cancelled or unavailable.', 'sys');
    }
  };

  // File Drop / Select
  const handleFile = (file: File) => {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = () => {
        const res = String(reader.result || '');
        setAttachedFile({
          name: file.name,
          size: file.size,
          mimeType: file.type,
          base64: res.split(',')[1],
        });
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        setAttachedFile({
          name: file.name,
          size: file.size,
          mimeType: file.type || 'text/plain',
          text: String(reader.result || '').slice(0, 24000),
        });
      };
      reader.readAsText(file);
    }
  };

  // Multi-Mode Search
  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setAssistantState('THINKING');
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, mode: searchMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setContentPanel({
        title: data.title || 'WEB SEARCH',
        body: data.body || '',
        sources: data.sources,
      });
      setSearchOpen(false);
    } catch (err) {
      await addMessage('system', `Search error: ${err instanceof Error ? err.message : 'failed'}`, 'sys');
    } finally {
      setAssistantState('STANDBY');
    }
  };

  // Clipboard Intelligence
  const runClipboardAction = async (action: 'translate' | 'summarize' | 'explain' | 'fix') => {
    if (!clipboardText.trim()) return;
    setAssistantState('THINKING');
    try {
      const res = await fetch('/api/clipboard/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clipboardText, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      setContentPanel({
        title: `CLIPBOARD · ${action.toUpperCase()}`,
        body: data.result || '',
      });
      setClipboardOpen(false);
    } catch (err) {
      await addMessage('system', `Clipboard error: ${err instanceof Error ? err.message : 'failed'}`, 'sys');
    } finally {
      setAssistantState('STANDBY');
    }
  };

  const inspectTask = (t: BackgroundTask) => {
    const body =
      t.status === 'done'
        ? `${t.title}\n\n${t.result}`
        : `${t.title}\nStatus: ${t.status.toUpperCase()} (${t.agent})\n\n${t.steps.map((s) => `· ${s}`).join('\n')}`;
    setContentPanel({ title: 'BACKGROUND TASK', body });
  };

  const inspectRoutine = (r: RoutineItem) => {
    const body = [
      r.name,
      '',
      `Trigger: ${r.triggerType} (${r.scheduleText})`,
      `Kind: ${r.kind}`,
      `Action: ${r.text}`,
      `State: ${r.enabled ? 'ENABLED' : 'DISABLED'} · Runs: ${r.runs}`,
    ].join('\n');
    setContentPanel({ title: 'ROUTINE DETAIL', body });
  };

  const triggerBriefingNow = () => {
    void sendCommand(
      `Deliver a cinematic ${assistantName} opening status briefing for ${userName}: report workshop readiness and current time (${clockStr}), summarize stored project/session context, note top global tech developments, and stand by with calm composure.`
    );
  };

  // Auth loading or Sign-In Gate
  if (!authReady) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ backgroundColor: PALETTE_DEFAULTS.BG }}>
        <div className="text-center space-y-2">
          <div className="text-sm font-mono tracking-[4px]" style={{ color: PALETTE_DEFAULTS.PRI }}>
            INITIALISING MARK LVII CORE...
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div
        className="h-screen w-screen flex items-center justify-center p-4"
        style={{ backgroundColor: PALETTE_DEFAULTS.BG }}
      >
        <div
          className="hud-chamfer w-full max-w-md border p-6 space-y-5"
          style={{
            backgroundColor: PALETTE_DEFAULTS.PANEL,
            borderColor: PALETTE_DEFAULTS.BORDER_B,
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-full border-2 flex items-center justify-center"
              style={{ borderColor: PALETTE_DEFAULTS.PRI, boxShadow: `0 0 14px ${PALETTE_DEFAULTS.PRI}44` }}
            >
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PALETTE_DEFAULTS.PRI }} />
            </div>
            <div>
              <h1 className="text-xl font-light tracking-[5px]" style={{ color: PALETTE_DEFAULTS.WHITE }}>
                J.A.R.V.I.S
              </h1>
              <p className="text-[10px] font-semibold tracking-[2.2px]" style={{ color: PALETTE_DEFAULTS.PRI_DIM }}>
                MARK LVII · PERSONAL AI SYSTEM
              </p>
            </div>
          </div>

          <p className="text-xs leading-relaxed" style={{ color: PALETTE_DEFAULTS.TEXT_MED }}>
            Authenticate to synchronize your holographic HUD preferences, persistent long-term memory, automated routines, and autonomous background tasks via encrypted cloud storage.
          </p>

          {authError && (
            <div className="p-2.5 border text-xs" style={{ borderColor: PALETTE_DEFAULTS.RED, color: PALETTE_DEFAULTS.RED }}>
              {authError}
            </div>
          )}

          <button
            onClick={signIn}
            className="w-full py-2.5 px-4 border text-xs font-semibold tracking-[2px] uppercase flex items-center justify-center gap-2 cursor-pointer transition-opacity hover:opacity-90"
            style={{
              backgroundColor: PALETTE_DEFAULTS.PRI_GHO,
              borderColor: PALETTE_DEFAULTS.PRI,
              color: PALETTE_DEFAULTS.WHITE,
            }}
          >
            <ShieldCheck className="w-4 h-4" /> Sign In with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--hud-bg)', color: 'var(--hud-text)' }}
    >
      {/* ── HEADER BAR ── */}
      <header
        className="h-14 shrink-0 px-3.5 flex items-center justify-between border-b relative z-30"
        style={{
          backgroundColor: 'var(--hud-panel)',
          borderColor: 'var(--hud-border)',
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* ArcLogo */}
          <div
            className="w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0"
            style={{
              borderColor: 'var(--hud-pri)',
              boxShadow: '0 0 10px var(--hud-pri-dim)',
            }}
          >
            <div
              className="w-3 h-3 rounded-full border"
              style={{
                borderColor: 'var(--hud-white)',
                backgroundColor: 'var(--hud-pri-gho)',
              }}
            />
          </div>

          <div className="min-w-0">
            <div
              className="text-lg font-light tracking-[3.5px] leading-tight truncate"
              style={{ color: 'var(--hud-white)' }}
            >
              {assistantName.toUpperCase()}
            </div>
            <div
              className="text-[9px] font-semibold tracking-[2px] uppercase truncate"
              style={{ color: 'var(--hud-pri-dim)' }}
            >
              MARK LVII · PERSONAL AI SYSTEM
            </div>
          </div>

          {/* Gear (SETUP) + Sliders (CONTROLS) */}
          <div className="flex items-center gap-1.5 ml-2">
            <button
              onClick={() => {
                setSetupOpen((v) => !v);
                setControlsOpen(false);
              }}
              title="Setup — things you set once"
              className="w-8 h-8 border flex items-center justify-center cursor-pointer"
              style={{
                backgroundColor: setupOpen ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
                borderColor: setupOpen ? 'var(--hud-pri)' : 'var(--hud-border)',
                color: setupOpen ? 'var(--hud-white)' : 'var(--hud-text-med)',
              }}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setControlsOpen((v) => !v);
                setSetupOpen(false);
              }}
              title="Controls — everyday switches"
              className="w-8 h-8 border flex items-center justify-center cursor-pointer"
              style={{
                backgroundColor: controlsOpen ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
                borderColor: controlsOpen ? 'var(--hud-pri)' : 'var(--hud-border)',
                color: controlsOpen ? 'var(--hud-white)' : 'var(--hud-text-med)',
              }}
            >
              <Sliders className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Center StateChip */}
        <div
          className="hidden md:flex items-center gap-2 px-3 py-1 border text-[10px] font-mono tracking-[2px]"
          style={{
            backgroundColor: 'var(--hud-panel2)',
            borderColor: 'var(--hud-border-a)',
            color:
              assistantState === 'SPEAKING'
                ? 'var(--hud-acc)'
                : assistantState === 'LISTENING'
                ? 'var(--hud-green)'
                : 'var(--hud-pri)',
          }}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor:
                assistantState === 'SPEAKING'
                  ? 'var(--hud-acc)'
                  : assistantState === 'LISTENING'
                  ? 'var(--hud-green)'
                  : 'var(--hud-pri)',
            }}
          />
          {assistantState}
        </div>

        {/* Right Clock & Controls */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right hidden sm:block">
            <div
              className="text-lg font-light font-mono tracking-[1px] leading-tight"
              style={{ color: 'var(--hud-white)' }}
            >
              {clockStr}
            </div>
            <div
              className="text-[9px] font-semibold tracking-[1.5px]"
              style={{ color: 'var(--hud-pri-dim)' }}
            >
              {dateStr}
            </div>
          </div>

          <button
            onClick={() => {
              if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen?.().catch(() => {});
              } else {
                document.exitFullscreen?.().catch(() => {});
              }
            }}
            title="Fullscreen [F11]"
            className="w-8 h-8 border flex items-center justify-center cursor-pointer"
            style={{
              backgroundColor: 'var(--hud-panel2)',
              borderColor: 'var(--hud-border)',
              color: 'var(--hud-text-med)',
            }}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={logout}
            title={`Sign out (${user.email})`}
            className="w-8 h-8 border flex items-center justify-center cursor-pointer"
            style={{
              backgroundColor: 'var(--hud-panel2)',
              borderColor: 'var(--hud-border)',
              color: 'var(--hud-text-dim)',
            }}
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Floating SETUP Drawer */}
        {setupOpen && (
          <div
            className="hud-chamfer absolute top-15 left-3.5 w-60 border p-2.5 space-y-1.5 z-40 shadow-2xl"
            style={{
              backgroundColor: 'var(--hud-panel)',
              borderColor: 'var(--hud-border-b)',
            }}
          >
            <div className="text-[9px] font-semibold tracking-[2px] px-1 pb-1 border-b" style={{ color: 'var(--hud-pri-dim)', borderColor: 'var(--hud-border)' }}>
              SETUP
            </div>
            {[
              { label: 'REMOTE COMPANION', onClick: () => setActiveOverlay('remote'), primary: true },
              { label: 'SERVER NODE', onClick: () => setActiveOverlay('server') },
              { label: 'CUSTOMISE ASSISTANT', onClick: () => setActiveOverlay('customize') },
              { label: 'MEMORY & MONITORS', onClick: () => setActiveOverlay('memory') },
              { label: 'ENGINE & CAPABILITIES', onClick: () => setActiveOverlay('engine') },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  setSetupOpen(false);
                  item.onClick();
                }}
                className="w-full text-left px-2.5 py-1.5 text-[11px] font-semibold tracking-[1.2px] border border-l-[3px] cursor-pointer"
                style={{
                  backgroundColor: item.primary ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
                  borderColor: item.primary ? 'var(--hud-pri-dim)' : 'var(--hud-border)',
                  borderLeftColor: item.primary ? 'var(--hud-pri)' : 'var(--hud-border-a)',
                  color: item.primary ? 'var(--hud-pri)' : 'var(--hud-text-med)',
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {/* Floating CONTROLS Drawer */}
        {controlsOpen && (
          <div
            className="hud-chamfer absolute top-15 left-14 w-64 border p-2.5 space-y-1.5 z-40 shadow-2xl"
            style={{
              backgroundColor: 'var(--hud-panel)',
              borderColor: 'var(--hud-border-b)',
            }}
          >
            <div className="text-[9px] font-semibold tracking-[2px] px-1 pb-1 border-b" style={{ color: 'var(--hud-pri-dim)', borderColor: 'var(--hud-border)' }}>
              CONTROLS
            </div>
            <button
              onClick={() => {
                void updateProfileSettings({ hudStyle: hudStyle === 'face' ? 'reactor' : 'face' });
              }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-semibold tracking-[1.2px] border border-l-[3px] cursor-pointer"
              style={{
                backgroundColor: 'var(--hud-panel2)',
                borderColor: 'var(--hud-border)',
                borderLeftColor: 'var(--hud-pri)',
                color: 'var(--hud-white)',
              }}
            >
              HUD STYLE: {hudStyle === 'face' ? '3D FACE' : '3D REACTOR'}
            </button>
            <button
              onClick={() => setVoiceEnabled((v) => !v)}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-semibold tracking-[1.2px] border border-l-[3px] cursor-pointer"
              style={{
                backgroundColor: 'var(--hud-panel2)',
                borderColor: 'var(--hud-border)',
                borderLeftColor: voiceEnabled ? 'var(--hud-green)' : 'var(--hud-border-a)',
                color: voiceEnabled ? 'var(--hud-green)' : 'var(--hud-text-dim)',
              }}
            >
              VOICE OUTPUT: {voiceEnabled ? 'ON' : 'MUTED'}
            </button>
            <button
              onClick={() => {
                if (profile) {
                  void updateProfileSettings({ morningBrief: !profile.morningBrief });
                }
              }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-semibold tracking-[1.2px] border border-l-[3px] cursor-pointer"
              style={{
                backgroundColor: 'var(--hud-panel2)',
                borderColor: 'var(--hud-border)',
                borderLeftColor: profile?.morningBrief ? 'var(--hud-green)' : 'var(--hud-border-a)',
                color: profile?.morningBrief ? 'var(--hud-green)' : 'var(--hud-text-dim)',
              }}
            >
              MORNING BRIEF: {profile?.morningBrief ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => {
                setControlsOpen(false);
                triggerBriefingNow();
              }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-semibold tracking-[1.2px] border border-l-[3px] cursor-pointer flex items-center gap-1.5"
              style={{
                backgroundColor: 'var(--hud-pri-gho)',
                borderColor: 'var(--hud-pri-dim)',
                borderLeftColor: 'var(--hud-pri)',
                color: 'var(--hud-pri)',
              }}
            >
              <Play className="w-3 h-3" /> RUN OPENING BRIEFING
            </button>
            <div className="pt-1 flex items-center gap-1.5 flex-wrap">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.hex}
                  onClick={() => void updateProfileSettings({ accentColor: p.hex })}
                  title={p.label}
                  className="w-5 h-5 border cursor-pointer"
                  style={{
                    backgroundColor: p.hex,
                    borderColor: accentColor.toLowerCase() === p.hex ? '#ffffff' : 'var(--hud-border)',
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </header>

      {/* ── MAIN 3-COLUMN BODY ── */}
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[240px_1fr_340px] gap-2.5 p-2.5 overflow-hidden">
        {/* LEFT COLUMN */}
        <section className="hidden lg:flex flex-col gap-2.5 min-h-0">
          <ChamferPanel title="SYSTEM TELEMETRY" code={`${telemetry.cores} CORES`}>
            <div className="grid grid-cols-2 gap-1.5">
              <RingGauge label="CPU" value={telemetry.cpu} displayText={`${telemetry.cpu}%`} />
              <RingGauge label="MEM" value={telemetry.mem} displayText={`${telemetry.mem}%`} />
              <RingGauge label="HEAP" value={telemetry.heap} displayText={`${telemetry.heap}%`} />
              <RingGauge label="TEMP" value={telemetry.temp} displayText={`${telemetry.temp}°`} />
            </div>
          </ChamferPanel>

          <ChamferPanel title="NETWORK" code={`${telemetry.netKB} KB/S`}>
            <Sparkline points={netHistory} />
          </ChamferPanel>

          <ChamferPanel title="STATUS" code={dbOnline ? 'SYNC' : 'LOCAL'}>
            <div className="space-y-1 text-[10px] font-mono">
              <div className="flex justify-between">
                <span style={{ color: 'var(--hud-text-dim)' }}>ENGINE</span>
                <span style={{ color: 'var(--hud-white)' }}>GEMINI-4</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--hud-text-dim)' }}>VOICE</span>
                <span style={{ color: 'var(--hud-pri)' }}>{voiceName.toUpperCase()}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--hud-text-dim)' }}>MEMORY</span>
                <span style={{ color: 'var(--hud-green)' }}>{memories.length} ITEMS</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--hud-text-dim)' }}>UPTIME</span>
                <span style={{ color: 'var(--hud-green)' }}>{formatUptime(telemetry.uptimeSeconds)}</span>
              </div>
              <button
                type="button"
                onClick={() => setActiveOverlay('server')}
                className="w-full flex justify-between items-center pt-1 mt-1 border-t cursor-pointer hover:opacity-80"
                style={{ borderColor: 'var(--hud-border)' }}
              >
                <span style={{ color: 'var(--hud-text-dim)' }}>SERVER NODE</span>
                <span
                  style={{
                    color: remoteStatus?.online
                      ? 'var(--hud-green)'
                      : remoteStatus?.configured
                      ? 'var(--hud-red)'
                      : 'var(--hud-text-dim)',
                  }}
                >
                  {remoteStatus?.online
                    ? `${remoteStatus.hostname} · ${remoteStatus.cpuPct}%`
                    : remoteStatus?.configured
                    ? 'OFFLINE'
                    : 'UNSET'}
                </span>
              </button>
            </div>
          </ChamferPanel>

          <ChamferPanel
            title={leftTab === 'tasks' ? 'TASKS' : 'ROUTINES'}
            code={
              leftTab === 'tasks'
                ? `${tasks.filter((t) => t.status === 'running').length} ACTIVE`
                : `${routines.filter((r) => r.enabled).length} ON`
            }
            headerRight={
              <button
                onClick={() => setLeftTab((t) => (t === 'tasks' ? 'routines' : 'tasks'))}
                className="px-2 py-0.5 text-[9px] font-semibold tracking-[1px] border cursor-pointer"
                style={{
                  borderColor: 'var(--hud-border-a)',
                  color: 'var(--hud-pri)',
                  backgroundColor: 'var(--hud-panel)',
                }}
              >
                {leftTab === 'tasks' ? 'ROUTINES' : 'TASKS'}
              </button>
            }
            className="flex-1 min-h-0"
          >
            <div className="flex-1 overflow-y-auto hud-scroll space-y-1.5 pr-1">
              {leftTab === 'tasks' ? (
                tasks.length === 0 ? (
                  <p className="text-[11px]" style={{ color: 'var(--hud-text-dim)' }}>
                    No background tasks yet. Ask J.A.R.V.I.S to research a topic in the background.
                  </p>
                ) : (
                  tasks.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => inspectTask(t)}
                      className="w-full text-left p-2 border cursor-pointer hover:opacity-90"
                      style={{
                        backgroundColor: 'var(--hud-panel2)',
                        borderColor: 'var(--hud-border)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
                          {t.title}
                        </span>
                        <span
                          className="text-[9px] font-mono uppercase shrink-0"
                          style={{
                            color:
                              t.status === 'done'
                                ? 'var(--hud-green)'
                                : t.status === 'failed'
                                ? 'var(--hud-red)'
                                : 'var(--hud-acc2)',
                          }}
                        >
                          {t.status}
                        </span>
                      </div>
                      <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--hud-text-dim)' }}>
                        {t.agent} · {t.steps[t.steps.length - 1] || 'Queued'}
                      </div>
                    </button>
                  ))
                )
              ) : (
                routines.map((r) => (
                  <div
                    key={r.id}
                    className="p-2 border flex items-center justify-between gap-2"
                    style={{
                      backgroundColor: 'var(--hud-panel2)',
                      borderColor: 'var(--hud-border)',
                    }}
                  >
                    <button
                      onClick={() => inspectRoutine(r)}
                      className="text-left min-w-0 flex-1 cursor-pointer"
                    >
                      <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
                        {r.name}
                      </div>
                      <div className="text-[9px] truncate" style={{ color: 'var(--hud-text-dim)' }}>
                        {r.scheduleText}
                      </div>
                    </button>
                    <button
                      onClick={() => void toggleRoutine(r.id, !r.enabled)}
                      className="px-1.5 py-0.5 text-[9px] font-mono border cursor-pointer shrink-0"
                      style={{
                        borderColor: r.enabled ? 'var(--hud-green-d)' : 'var(--hud-border)',
                        color: r.enabled ? 'var(--hud-green)' : 'var(--hud-text-dim)',
                      }}
                    >
                      {r.enabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                ))
              )}
            </div>
          </ChamferPanel>
        </section>

        {/* CENTER COLUMN — 3D HUD + DYNAMIC CONTENT PANEL */}
        <section className="flex flex-col gap-2.5 min-h-0 relative">
          <div
            className="flex-1 min-h-0 border relative overflow-hidden"
            style={{ borderColor: 'var(--hud-border)' }}
          >
            <HudCanvas
              hudStyle={hudStyle}
              state={assistantState}
              assistantName={assistantName}
              audioLevel={audioLevel}
              palette={palette}
            />

            {/* Floating Webcam Preview (Mark-XXX bottom-right of HUD) */}
            {cameraOpen && (
              <div
                className="absolute bottom-3 right-3 w-48 border p-1.5 z-20"
                style={{
                  backgroundColor: 'var(--hud-panel)',
                  borderColor: 'var(--hud-pri)',
                }}
              >
                <video ref={videoRef} className="w-full h-28 object-cover bg-black" muted playsInline />
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={captureCameraFrame}
                    className="flex-1 py-1 text-[9px] font-semibold uppercase border cursor-pointer"
                    style={{
                      backgroundColor: 'var(--hud-pri-gho)',
                      borderColor: 'var(--hud-pri)',
                      color: 'var(--hud-white)',
                    }}
                  >
                    Analyze Frame
                  </button>
                  <button
                    onClick={toggleCamera}
                    className="px-2 py-1 text-[9px] border cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-red)' }}
                  >
                    Off
                  </button>
                </div>
              </div>
            )}

            {/* Quick Tool Ribbon top-right of HUD */}
            <div className="absolute top-3 right-3 flex items-center gap-1.5 z-20">
              <button
                onClick={() => {
                  setSearchOpen((v) => !v);
                  setClipboardOpen(false);
                }}
                className="px-2 py-1 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                style={{
                  backgroundColor: 'var(--hud-panel)',
                  borderColor: searchOpen ? 'var(--hud-pri)' : 'var(--hud-border)',
                  color: 'var(--hud-text)',
                }}
              >
                <Search className="w-3 h-3" /> SEARCH
              </button>
              <button
                onClick={() => {
                  setClipboardOpen((v) => !v);
                  setSearchOpen(false);
                }}
                className="px-2 py-1 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                style={{
                  backgroundColor: 'var(--hud-panel)',
                  borderColor: clipboardOpen ? 'var(--hud-pri)' : 'var(--hud-border)',
                  color: 'var(--hud-text)',
                }}
              >
                <Clipboard className="w-3 h-3" /> CLIPBOARD
              </button>
              <button
                onClick={() => setVoiceEnabled((v) => !v)}
                className="p-1.5 border cursor-pointer"
                style={{
                  backgroundColor: 'var(--hud-panel)',
                  borderColor: 'var(--hud-border)',
                  color: voiceEnabled ? 'var(--hud-pri)' : 'var(--hud-text-dim)',
                }}
                title="Toggle TTS Voice"
              >
                {voiceEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* Search Sub-Panel */}
            {searchOpen && (
              <form
                onSubmit={runSearch}
                className="absolute top-12 right-3 left-3 md:left-auto md:w-96 border p-2.5 z-30 space-y-2"
                style={{
                  backgroundColor: 'var(--hud-panel)',
                  borderColor: 'var(--hud-pri)',
                }}
              >
                <div className="flex gap-1 flex-wrap">
                  {(['search', 'news', 'research', 'price', 'compare'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setSearchMode(m)}
                      className="px-2 py-0.5 text-[9px] font-mono uppercase border cursor-pointer"
                      style={{
                        backgroundColor: searchMode === m ? 'var(--hud-pri-gho)' : 'transparent',
                        borderColor: searchMode === m ? 'var(--hud-pri)' : 'var(--hud-border)',
                        color: searchMode === m ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                      }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Multi-mode Google Search query..."
                    className="flex-1 px-2 py-1 text-xs border outline-none"
                    style={{
                      backgroundColor: 'var(--hud-bg)',
                      borderColor: 'var(--hud-border-a)',
                      color: 'var(--hud-white)',
                    }}
                  />
                  <button
                    type="submit"
                    className="px-3 py-1 text-[10px] font-semibold uppercase border cursor-pointer"
                    style={{
                      backgroundColor: 'var(--hud-pri-gho)',
                      borderColor: 'var(--hud-pri)',
                      color: 'var(--hud-white)',
                    }}
                  >
                    Go
                  </button>
                </div>
              </form>
            )}

            {/* Clipboard Intelligence Panel */}
            {clipboardOpen && (
              <div
                className="absolute top-12 right-3 left-3 md:left-auto md:w-96 border p-2.5 z-30 space-y-2"
                style={{
                  backgroundColor: 'var(--hud-panel)',
                  borderColor: 'var(--hud-pri)',
                }}
              >
                <textarea
                  value={clipboardText}
                  onChange={(e) => setClipboardText(e.target.value)}
                  rows={3}
                  placeholder="Paste text or code for Clipboard Intelligence..."
                  className="w-full p-2 text-xs border outline-none resize-none"
                  style={{
                    backgroundColor: 'var(--hud-bg)',
                    borderColor: 'var(--hud-border-a)',
                    color: 'var(--hud-white)',
                  }}
                />
                <div className="grid grid-cols-4 gap-1">
                  {(['translate', 'summarize', 'explain', 'fix'] as const).map((act) => (
                    <button
                      key={act}
                      onClick={() => void runClipboardAction(act)}
                      className="py-1 text-[9px] font-semibold uppercase border cursor-pointer"
                      style={{
                        backgroundColor: 'var(--hud-pri-gho)',
                        borderColor: 'var(--hud-pri-dim)',
                        color: 'var(--hud-white)',
                      }}
                    >
                      {act}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Dynamic Content Panel below HUD */}
          {contentPanel && (
            <ChamferPanel
              title={contentPanel.title}
              code="DYNAMIC PANEL"
              headerRight={
                <button
                  onClick={() => setContentPanel(null)}
                  className="p-0.5 hover:opacity-75 cursor-pointer"
                  style={{ color: 'var(--hud-text-med)' }}
                  aria-label="Close content panel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              }
              className="h-52 shrink-0"
            >
              <div className="flex-1 overflow-y-auto hud-scroll text-xs leading-relaxed whitespace-pre-wrap hud-selectable pr-1" style={{ color: 'var(--hud-white)' }}>
                {contentPanel.body}
                {contentPanel.sources && contentPanel.sources.length > 0 && (
                  <div className="mt-3 pt-2 border-t space-y-1" style={{ borderColor: 'var(--hud-border)' }}>
                    <div className="text-[9px] font-mono uppercase" style={{ color: 'var(--hud-pri-dim)' }}>
                      Verified Sources
                    </div>
                    {contentPanel.sources.map((s, idx) => (
                      <a
                        key={`${s.uri}_${idx}`}
                        href={s.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-[11px] underline truncate"
                        style={{ color: 'var(--hud-pri)' }}
                      >
                        {s.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </ChamferPanel>
          )}
        </section>

        {/* RIGHT COLUMN — COMMUNICATIONS LOG + COMMAND INPUT */}
        <section className="flex flex-col gap-2.5 min-h-0">
          <ChamferPanel title="COMMUNICATIONS" code="LOG" className="flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto hud-scroll space-y-2 pr-1 hud-selectable">
              {messages.length === 0 ? (
                <div className="text-xs leading-relaxed p-2" style={{ color: 'var(--hud-text-dim)' }}>
                  At your service, {userName}. {assistantName} Mark LVII is online — all core systems nominal. Issue a command, attach a file, activate voice [F4], or request an opening briefing.
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`p-2 border text-xs leading-relaxed ${
                      m.role === 'system' ? 'opacity-80 italic' : ''
                    }`}
                    style={{
                      backgroundColor:
                        m.role === 'assistant' ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
                      borderColor:
                        m.role === 'assistant' ? 'var(--hud-pri-dim)' : 'var(--hud-border)',
                      color:
                        m.role === 'assistant'
                          ? 'var(--hud-white)'
                          : m.role === 'system'
                          ? 'var(--hud-text-dim)'
                          : 'var(--hud-text)',
                    }}
                  >
                    <div className="flex items-center justify-between text-[9px] font-mono tracking-[1.5px] uppercase mb-1">
                      <span
                        style={{
                          color:
                            m.role === 'assistant'
                              ? 'var(--hud-pri)'
                              : m.role === 'system'
                              ? 'var(--hud-acc)'
                              : 'var(--hud-green)',
                        }}
                      >
                        {m.role === 'assistant'
                          ? assistantName.toUpperCase()
                          : m.role === 'user'
                          ? userName.toUpperCase()
                          : 'SYS'}
                      </span>
                      <span style={{ color: 'var(--hud-text-dim)' }}>{m.source}</span>
                    </div>
                    <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </ChamferPanel>

          <ChamferPanel title="COMMAND" code="INPUT" className="shrink-0">
            <div className="space-y-2">
              {/* File Drop Zone */}
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleFile(f);
                }}
                onClick={() => fileInputRef.current?.click()}
                className="border border-dashed px-2.5 py-1.5 flex items-center justify-between text-[10px] cursor-pointer"
                style={{
                  borderColor: attachedFile ? 'var(--hud-pri)' : 'var(--hud-border-b)',
                  backgroundColor: 'var(--hud-bg)',
                  color: attachedFile ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                }}
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Upload className="w-3 h-3 shrink-0" />
                  {attachedFile
                    ? `${attachedFile.name} (${Math.round(attachedFile.size / 1024)} KB)`
                    : 'Drop image or text file here, or click'}
                </span>
                {attachedFile && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAttachedFile(null);
                    }}
                    className="ml-2 text-[9px] uppercase cursor-pointer"
                    style={{ color: 'var(--hud-red)' }}
                  >
                    Clear
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
              </div>

              {/* Command Input Row */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendCommand();
                }}
                className="flex items-center gap-1.5 border px-2.5 py-1.5"
                style={{
                  backgroundColor: 'var(--hud-bg)',
                  borderColor: 'var(--hud-border-a)',
                }}
              >
                <span className="text-base leading-none font-light" style={{ color: 'var(--hud-pri)' }}>
                  ›
                </span>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a command or question…"
                  className="flex-1 bg-transparent text-xs outline-none"
                  style={{ color: 'var(--hud-white)' }}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="p-1 cursor-pointer disabled:opacity-40"
                  style={{ color: 'var(--hud-pri)' }}
                  aria-label="Send command"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>

              {/* Action Buttons: MIC ACTIVE + INTERRUPT + CAMERA + SCREEN */}
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={toggleMic}
                  className="py-1.5 px-2 border text-[10px] font-semibold tracking-[1px] uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  style={{
                    backgroundColor: micActive ? 'var(--hud-panel2)' : 'var(--hud-panel)',
                    borderColor: micActive ? 'var(--hud-green)' : 'var(--hud-border)',
                    color: micActive ? 'var(--hud-green)' : 'var(--hud-text-med)',
                  }}
                >
                  {micActive ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                  {micActive ? 'MIC ACTIVE' : 'VOICE [F4]'}
                </button>
                <button
                  onClick={stopSpeaking}
                  className="py-1.5 px-2 border text-[10px] font-semibold tracking-[1px] uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--hud-panel)',
                    borderColor: 'var(--hud-border)',
                    color: 'var(--hud-muted-c)',
                  }}
                >
                  <Square className="w-3 h-3" /> INTERRUPT
                </button>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={toggleCamera}
                  className="py-1 px-2 border text-[9px] font-semibold tracking-[1px] uppercase flex items-center justify-center gap-1 cursor-pointer"
                  style={{
                    backgroundColor: cameraOpen ? 'var(--hud-pri-gho)' : 'var(--hud-panel)',
                    borderColor: cameraOpen ? 'var(--hud-pri)' : 'var(--hud-border)',
                    color: cameraOpen ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                  }}
                >
                  <Camera className="w-3 h-3" /> {cameraOpen ? 'CAM ON' : 'WEBCAM'}
                </button>
                <button
                  onClick={captureScreen}
                  className="py-1 px-2 border text-[9px] font-semibold tracking-[1px] uppercase flex items-center justify-center gap-1 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--hud-panel)',
                    borderColor: 'var(--hud-border)',
                    color: 'var(--hud-text-dim)',
                  }}
                >
                  <Monitor className="w-3 h-3" /> SCREEN VISION
                </button>
              </div>
            </div>
          </ChamferPanel>
        </section>
      </main>

      {/* Overlays */}
      {activeOverlay === 'customize' && profile && (
        <CustomizeOverlay
          profile={profile}
          onSave={updateProfileSettings}
          onClose={() => setActiveOverlay(null)}
        />
      )}
      {activeOverlay === 'memory' && (
        <MemoryOverlay
          memories={memories}
          monitors={monitors}
          onAddMemory={addMemory}
          onDeleteMemory={removeMemory}
          onAddMonitor={createMonitor}
          onDeleteMonitor={removeMonitor}
          onClose={() => setActiveOverlay(null)}
        />
      )}
      {activeOverlay === 'remote' && (
        <RemoteOverlay onClose={() => setActiveOverlay(null)} />
      )}
      {activeOverlay === 'server' && (
        <ServerNodeOverlay
          status={remoteStatus}
          onStatusChange={setRemoteStatus}
          onOpenFile={(p) => {
            setActiveOverlay(null);
            void openRemoteFileInHud(p);
          }}
          onClose={() => setActiveOverlay(null)}
        />
      )}
      {activeOverlay === 'engine' && (
        <EngineOverlay onClose={() => setActiveOverlay(null)} />
      )}
      {remoteFileViewer && (
        <RemoteFileViewerOverlay
          file={remoteFileViewer}
          onClose={() => setRemoteFileViewer(null)}
        />
      )}
    </div>
  );
}
