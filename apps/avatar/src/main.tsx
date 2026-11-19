import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import './styles.css';
import { Overlay } from './pages/Overlay.tsx';
import { AvatarOnly } from './pages/AvatarOnly.tsx';
import { Control } from './pages/Control.tsx';
import { ControlCenter } from './pages/ControlCenter.tsx';

function App() {
  const p = location.pathname.replace(/\/+$/, '');
  if (p === '/overlay') return <Overlay />;
  if (p === '/avatar') return <AvatarOnly />;
  if (p === '/control') return <Control />;
  if (p === '' || p === '/setup' || p === '/center') return <ControlCenter />;
  return (
    <div className="landing">
      <img src="/assets-hubie/hubie-reference.png" width={160} height={160} alt="Hubie" />
      <h1>Hubie Streamer</h1>
      <p><a href="/overlay">/overlay</a> — full 1920×1080 stream layout (OBS browser source, plays audio)</p>
      <p><a href="/avatar">/avatar</a> — transparent avatar only (add <code>?audio=0</code> if the overlay also plays audio)</p>
      <p><a href="/setup">/setup</a> — control center (AI, voice, Limbo, Kick, OBS, audio, avatar, health, go live)</p>
      <p><a href="/control">/control</a> — operator panel: test events, chat, expressions, e-stop, health</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
