import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, CircleAlert } from 'lucide-react';
import './profile-avatar.css';

const AVATAR_KEY = 'huikan.profile.avatar.v1';
const avatars = Array.from({ length: 5 }, (_, index) => ({ id: `avatar-${index + 1}`, src: `/avatars/avatar-${index + 1}.jpg`, label: `头像 ${index + 1}` }));
const safeAvatar = value => avatars.find(item => item.id === value) || avatars[1];

function readAvatar() {
  try { return { avatar: safeAvatar(window.localStorage.getItem(AVATAR_KEY)), error: '' }; }
  catch { return { avatar: avatars[1], error: '暂时无法读取已保存的头像。' }; }
}

export default function ProfileAvatar() {
  const [selection, setSelection] = useState(readAvatar);
  const [open, setOpen] = useState(false);
  const chosenButton = useRef(null);

  useEffect(() => {
    function syncAvatar(event) {
      if (event.key !== AVATAR_KEY && event.key !== null) return;
      try { if (event.storageArea !== window.localStorage) return; }
      catch { return; }
      setSelection({ avatar: safeAvatar(event.newValue), error: '' });
    }
    window.addEventListener('storage', syncAvatar);
    return () => window.removeEventListener('storage', syncAvatar);
  }, []);

  function chooseAvatar(avatar) {
    try {
      window.localStorage.setItem(AVATAR_KEY, avatar.id);
      setSelection({ avatar, error: '' });
      setOpen(false);
    } catch {
      setSelection(previous => ({ ...previous, error: '头像未能保存，请重试。' }));
    }
  }

  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className="pav-trigger" aria-label="更换头像"><img src={selection.avatar.src} alt="当前头像" width="36" height="36"/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="pav-popover" side="bottom" align="start" sideOffset={10} collisionPadding={12} aria-label="选择头像" onOpenAutoFocus={event => { event.preventDefault(); chosenButton.current?.focus({ preventScroll: true }); }}>
      <p className="pav-title">选择头像</p>
      <div className="pav-options" role="group" aria-label="可用头像">{avatars.map(avatar => <button key={avatar.id} ref={selection.avatar.id === avatar.id ? chosenButton : undefined} type="button" className="pav-option" aria-label={`选择${avatar.label}`} aria-pressed={selection.avatar.id === avatar.id} onClick={() => chooseAvatar(avatar)}>
        <img src={avatar.src} alt="" width="48" height="48"/>{selection.avatar.id === avatar.id && <span className="pav-selected" aria-hidden="true"><Check size={10} strokeWidth={2.5}/></span>}
      </button>)}</div>
      {selection.error && <p className="pav-error" role="alert"><CircleAlert size={14} aria-hidden="true"/>{selection.error}</p>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
