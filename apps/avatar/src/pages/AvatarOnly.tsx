/** Transparent avatar-only page, for OBS setups that compose their own layout. */
import React from 'react';
import { useHubie } from '../useHubie.ts';
import { HubieSvg } from '../rig/HubieSvg.tsx';

export function AvatarOnly() {
  const { rt, params, audioBlocked } = useHubie('avatar', true);
  return (
    <div className="avatar-only" onClick={() => rt.player.unlock()}>
      {params && <HubieSvg p={params.p} t={params.t} width={1000} height={1000} />}
      {audioBlocked && <div className="audio-hint">Click to enable Hubie's voice</div>}
    </div>
  );
}
