import React, { useId, useState } from 'react';
import { citationReference, splitCitationRuns } from './inline-citations.js';
import './inline-citations.css';

export default function InlineCitations({ text, refs = [], onReference }) {
  const [expanded, setExpanded] = useState({});
  const id = useId();
  return splitCitationRuns(text).map((part, index) => {
    if (!part.numbers) return part.text;
    const open = Boolean(expanded[index]);
    const contentId = `${id}-sources-${index}`;
    return <span className="inline-citation-group" key={index}>
      <button type="button" className="inline-citation-toggle" aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded(previous => ({ ...previous, [index]: !previous[index] }))}>
        {open ? '收起来源' : `${part.numbers.length} 条来源`}<span className="inline-citation-chevron" aria-hidden="true"/>
      </button>
      <span id={contentId} className="inline-citation-items" hidden={!open}>{part.text.split(/(\[\d+\])/).map((token, tokenIndex) => {
        const number = /^\[(\d+)\]$/.exec(token)?.[1];
        const ref = number && citationReference(refs, number);
        return ref && onReference ? <button type="button" className="inline-citation-number" key={tokenIndex} aria-label={ref.label} onClick={() => onReference(ref)}>{token}</button> : token;
      })}</span>
    </span>;
  });
}
