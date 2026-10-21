import React, { lazy, Suspense, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './ui.jsx';

class PanelBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="aw-panel-load-error" role="alert"><strong>{this.props.label}暂时无法打开</strong><p>请检查网络或本地服务。仍可继续查看对话和成交记录。</p><Button variant="secondary" size="sm" onClick={() => window.location.reload()}><RefreshCw size={14}/>刷新页面</Button></section>;
  }
}

/** Keep lazy-load failures inside their panel. Browsers cache failed module
 * loads, so recovery explicitly refreshes the document and its module map. */
export default function AsyncPanel({ loader, label, ...props }) {
  const [Component] = useState(() => lazy(loader));
  return <PanelBoundary label={label}><Suspense fallback={<p className="j-hint" role="status">正在加载{label}…</p>}><Component {...props}/></Suspense></PanelBoundary>;
}
