import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PAGE_SIZE, paginationItems, paginationWindow } from './pagination.js';
import './pagination.css';

export function usePagination(total, resetKey) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const current = paginationWindow(total, state.key === resetKey ? state.page : 1);
  // Reconcile before rendering children so a removed last page never appears empty.
  if (state.key !== resetKey || state.page !== current.page) setState({ ...state, key: resetKey, page: current.page });
  return {
    ...current,
    onPageChange: page => setState({ key: resetKey, page: paginationWindow(total, page).page }),
    resetPage: () => setState(previous => ({ ...previous, key: resetKey, page: 1 })),
  };
}

export default function Pagination({ total, page, pageCount, start, end, onPageChange, disabled = false, label = '交易分页' }) {
  if (total <= PAGE_SIZE) return null;
  return <nav className="hk-pagination" aria-label={label}>
    <span className="hk-pagination-count" role="status" aria-live="polite">{start + 1}–{end} / {total} 笔</span>
    <div className="hk-pagination-controls">
      <div className="hk-pagination-pages">
        <button type="button" className="hk-page" aria-label="上一页" disabled={disabled || page === 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={16} aria-hidden="true"/></button>
        {paginationItems(page, pageCount).map(item => typeof item === 'number'
          ? <button key={item} type="button" className="hk-page" aria-label={`第 ${item} 页`} aria-current={page === item ? 'page' : undefined} disabled={disabled} onClick={() => onPageChange(item)}>{item}</button>
          : <span key={item} className="hk-page-gap" aria-hidden="true">…</span>)}
        <button type="button" className="hk-page" aria-label="下一页" disabled={disabled || page === pageCount} onClick={() => onPageChange(page + 1)}><ChevronRight size={16} aria-hidden="true"/></button>
      </div>
    </div>
  </nav>;
}
