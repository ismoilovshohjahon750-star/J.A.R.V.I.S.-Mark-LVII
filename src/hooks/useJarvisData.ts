import { useCallback, useEffect, useState } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  OperationType,
  auth,
  db,
  googleAuthProvider,
  handleFirestoreError,
  testFirestoreConnection,
} from '../lib/firebase';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  assistantName: string;
  userName: string;
  accentColor: string;
  hudStyle: 'face' | 'reactor';
  voiceName: string;
  morningBrief: boolean;
  pushToTalk: boolean;
  wakeWord: boolean;
}

export interface ChatMessage {
  id: string;
  uid: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  source: string;
  createdAt?: unknown;
}

export interface MemoryItem {
  id: string;
  uid: string;
  category: 'identity' | 'preference' | 'project' | 'session' | 'fact';
  key: string;
  content: string;
}

export interface BackgroundTask {
  id: string;
  uid: string;
  title: string;
  prompt: string;
  agent: 'general' | 'researcher';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  result: string;
  steps: string[];
  budgetMinutes: number;
}

export interface RoutineItem {
  id: string;
  uid: string;
  name: string;
  kind: 'say' | 'prompt' | 'task' | 'builtin';
  triggerType: 'time' | 'startup' | 'idle';
  scheduleText: string;
  text: string;
  enabled: boolean;
  quiet: boolean;
  runs: number;
}

export interface MonitorItem {
  id: string;
  uid: string;
  topic: string;
  frequency: 'daily' | 'hourly' | 'weekly';
  lastSummary: string;
  enabled: boolean;
}

function makeDocId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

export function useJarvisData() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [dbOnline, setDbOnline] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [routines, setRoutines] = useState<RoutineItem[]>([]);
  const [monitors, setMonitors] = useState<MonitorItem[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    testFirestoreConnection().then(setDbOnline);
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthReady(true);
      if (!u) {
        setProfile(null);
        setMessages([]);
        setMemories([]);
        setTasks([]);
        setRoutines([]);
        setMonitors([]);
      }
    });
    return () => unsub();
  }, []);

  // Ensure user profile & built-in Mark-XXX routines exist on sign-in
  useEffect(() => {
    if (!authReady || !user) return;
    const uid = user.uid;
    const userPath = `users/${uid}`;
    const userRef = doc(db, 'users', uid);

    let active = true;

    (async () => {
      try {
        const snap = await getDoc(userRef);
        if (!snap.exists() && active) {
          const defaultProfile = {
            uid,
            email: (user.email || 'user@example.com').slice(0, 256),
            displayName: (user.displayName || 'Operator').slice(0, 120),
            assistantName: 'J.A.R.V.I.S',
            userName: (user.displayName?.split(' ')[0] || 'Sir').slice(0, 80),
            accentColor: '#00d4ff',
            hudStyle: 'face' as const,
            voiceName: 'Charon',
            morningBrief: true,
            pushToTalk: false,
            wakeWord: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          await setDoc(userRef, defaultProfile);

          // Seed built-in Mark-XXX routines cleanly
          const builtinRoutines = [
            {
              id: 'routine_morning_brief',
              name: 'Morning Briefing',
              kind: 'builtin',
              triggerType: 'time',
              scheduleText: 'Daily 08:30',
              text: 'Greet user, summarize last session, read time and top news.',
              enabled: true,
              quiet: false,
            },
            {
              id: 'routine_idle_checkin',
              name: 'Proactive Check-In',
              kind: 'prompt',
              triggerType: 'idle',
              scheduleText: 'After 25 min quiet',
              text: 'Offer a brief context-aware status update or task check.',
              enabled: true,
              quiet: true,
            },
            {
              id: 'routine_topic_watch',
              name: 'Background Monitor Digest',
              kind: 'task',
              triggerType: 'time',
              scheduleText: 'Daily 12:00',
              text: 'Check configured topic monitors for new developments.',
              enabled: true,
              quiet: true,
            },
          ];

          for (const r of builtinRoutines) {
            await setDoc(doc(db, 'users', uid, 'routines', r.id), {
              uid,
              name: r.name,
              kind: r.kind,
              triggerType: r.triggerType,
              scheduleText: r.scheduleText,
              text: r.text,
              enabled: r.enabled,
              quiet: r.quiet,
              runs: 0,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        }
      } catch (err) {
        console.error('Bootstrap profile error:', err);
      }
    })();

    const unsubProfile = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          setProfile(snap.data() as UserProfile);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, userPath)
    );

    const msgQuery = query(
      collection(db, 'users', uid, 'messages'),
      where('uid', '==', uid),
      orderBy('createdAt', 'asc'),
      limit(80)
    );
    const unsubMsgs = onSnapshot(
      msgQuery,
      (snap) => {
        setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `${userPath}/messages`)
    );

    const memQuery = query(
      collection(db, 'users', uid, 'memories'),
      where('uid', '==', uid),
      orderBy('updatedAt', 'desc'),
      limit(50)
    );
    const unsubMems = onSnapshot(
      memQuery,
      (snap) => {
        setMemories(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<MemoryItem, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `${userPath}/memories`)
    );

    const taskQuery = query(
      collection(db, 'users', uid, 'tasks'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(20)
    );
    const unsubTasks = onSnapshot(
      taskQuery,
      (snap) => {
        setTasks(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BackgroundTask, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `${userPath}/tasks`)
    );

    const routineQuery = query(
      collection(db, 'users', uid, 'routines'),
      where('uid', '==', uid),
      limit(20)
    );
    const unsubRoutines = onSnapshot(
      routineQuery,
      (snap) => {
        setRoutines(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RoutineItem, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `${userPath}/routines`)
    );

    const monitorQuery = query(
      collection(db, 'users', uid, 'monitors'),
      where('uid', '==', uid),
      limit(20)
    );
    const unsubMonitors = onSnapshot(
      monitorQuery,
      (snap) => {
        setMonitors(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<MonitorItem, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `${userPath}/monitors`)
    );

    return () => {
      active = false;
      unsubProfile();
      unsubMsgs();
      unsubMems();
      unsubTasks();
      unsubRoutines();
      unsubMonitors();
    };
  }, [authReady, user]);

  const signIn = useCallback(async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      setAuthError(msg);
    }
  }, []);

  const logout = useCallback(async () => {
    await signOut(auth);
  }, []);

  const updateProfileSettings = useCallback(
    async (patch: Partial<Omit<UserProfile, 'uid' | 'email'>>) => {
      if (!user) return;
      const path = `users/${user.uid}`;
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          ...patch,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user]
  );

  const addMessage = useCallback(
    async (role: 'user' | 'assistant' | 'system', text: string, source = 'hud') => {
      if (!user || !text.trim()) return;
      const id = makeDocId('msg');
      const path = `users/${user.uid}/messages/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'messages', id), {
          uid: user.uid,
          role,
          text: text.trim().slice(0, 12000),
          source: source.slice(0, 64),
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const addMemory = useCallback(
    async (
      category: MemoryItem['category'],
      key: string,
      content: string
    ) => {
      if (!user || !key.trim() || !content.trim()) return;
      const id = makeDocId('mem');
      const path = `users/${user.uid}/memories/${id}`;
      const validCat = ['identity', 'preference', 'project', 'session', 'fact'].includes(category)
        ? category
        : 'fact';
      try {
        await setDoc(doc(db, 'users', user.uid, 'memories', id), {
          uid: user.uid,
          category: validCat,
          key: key.trim().slice(0, 120),
          content: content.trim().slice(0, 2000),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const removeMemory = useCallback(
    async (id: string) => {
      if (!user) return;
      const path = `users/${user.uid}/memories/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'memories', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user]
  );

  const createTask = useCallback(
    async (title: string, prompt: string, agent: 'general' | 'researcher' = 'researcher') => {
      if (!user) return null;
      const id = makeDocId('task');
      const path = `users/${user.uid}/tasks/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'tasks', id), {
          uid: user.uid,
          title: title.trim().slice(0, 200) || 'Background Task',
          prompt: prompt.trim().slice(0, 2000),
          agent: agent === 'general' ? 'general' : 'researcher',
          status: 'running',
          result: '',
          steps: ['Queued autonomous worker'],
          budgetMinutes: 5,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return id;
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const finishTask = useCallback(
    async (id: string, status: 'done' | 'failed' | 'cancelled', result: string, steps: string[]) => {
      if (!user) return;
      const path = `users/${user.uid}/tasks/${id}`;
      try {
        await updateDoc(doc(db, 'users', user.uid, 'tasks', id), {
          status,
          result: result.slice(0, 16000),
          steps: steps.slice(0, 20).map((s) => s.slice(0, 300)),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user]
  );

  const createRoutine = useCallback(
    async (data: {
      name: string;
      kind: 'say' | 'prompt' | 'task' | 'builtin';
      triggerType: 'time' | 'startup' | 'idle';
      scheduleText: string;
      text: string;
    }) => {
      if (!user) return;
      const id = makeDocId('rt');
      const path = `users/${user.uid}/routines/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'routines', id), {
          uid: user.uid,
          name: data.name.trim().slice(0, 120) || 'Routine',
          kind: ['say', 'prompt', 'task', 'builtin'].includes(data.kind) ? data.kind : 'prompt',
          triggerType: ['time', 'startup', 'idle'].includes(data.triggerType) ? data.triggerType : 'time',
          scheduleText: data.scheduleText.trim().slice(0, 120) || 'Daily',
          text: data.text.trim().slice(0, 1000),
          enabled: true,
          quiet: false,
          runs: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const toggleRoutine = useCallback(
    async (id: string, enabled: boolean) => {
      if (!user) return;
      const path = `users/${user.uid}/routines/${id}`;
      try {
        await updateDoc(doc(db, 'users', user.uid, 'routines', id), {
          enabled,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user]
  );

  const createMonitor = useCallback(
    async (topic: string, frequency: 'daily' | 'hourly' | 'weekly' = 'daily') => {
      if (!user || !topic.trim()) return;
      const id = makeDocId('mon');
      const path = `users/${user.uid}/monitors/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'monitors', id), {
          uid: user.uid,
          topic: topic.trim().slice(0, 200),
          frequency: ['daily', 'hourly', 'weekly'].includes(frequency) ? frequency : 'daily',
          lastSummary: '',
          enabled: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const removeMonitor = useCallback(
    async (id: string) => {
      if (!user) return;
      const path = `users/${user.uid}/monitors/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'monitors', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user]
  );

  return {
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
  };
}
