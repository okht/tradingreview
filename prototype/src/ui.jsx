import React from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import './tooltip.css';

export function Button({ children, variant = 'primary', size = 'md', className = '', type = 'button', ...props }) {
  return <button type={type} className={`button ${variant} button-${size} ${className}`} {...props}>{children}</button>;
}

export const IconButton = React.forwardRef(function IconButton({ children, label, title, size = 'md', className = '', type = 'button', ...props }, ref) {
  const button = <button ref={ref} type={type} className={`icon-button icon-button-${size} ${className}`} aria-label={label} {...props}>{children}</button>;
  const description = title || label || props['aria-label'];
  if (!description) return button;
  return <Tooltip.Provider delayDuration={350}><Tooltip.Root><Tooltip.Trigger asChild>{button}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="hk-tooltip" side="top" sideOffset={8} collisionPadding={8}>{description}</Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
});

export function Tag({ children, tone = 'gray', className = '', ...props }) {
  return <span className={`tag ${tone} ${className}`} {...props}>{children}</span>;
}
