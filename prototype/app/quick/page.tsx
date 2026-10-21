'use client';
import { useEffect, useState, lazy, Suspense } from 'react';
import { experienceStorage } from '../../src/experience-mode.js';
import { initializeQuickExperience } from '../../src/quick-experience.js';
const AgentWorkspace = lazy(() => import('../../src/AgentWorkspace.jsx'));

export default function QuickPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    initializeQuickExperience(experienceStorage(window.localStorage, 'quick'))
      .then(() => { if (active) setReady(true); })
      .catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [attempt]);
  if (error) return <main style={{padding:32}}><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>重新加载</button> <a href="/">打开完整版</a></main>;
  return ready ? <Suspense fallback={<p style={{padding:32}}>正在打开经典案例…</p>}><AgentWorkspace/></Suspense> : <p style={{padding:32}}>正在打开经典案例…</p>;
}
