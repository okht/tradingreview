'use client';
import { useEffect, useState, lazy, Suspense } from 'react';
const AgentWorkspace = lazy(() => import('../src/AgentWorkspace.jsx'));
export default function Page() {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  return ready ? <Suspense fallback={<p style={{padding:32}}>正在打开 TradingReview…</p>}><AgentWorkspace/></Suspense> : <p style={{padding:32}}>正在打开 TradingReview…</p>;
}
