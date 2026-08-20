'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './share.module.css';

export interface SharePlayerProps {
  id: string;
  audioUrl: string;
  durationSec: number;
  playLabel: string;
  pauseLabel: string;
}

/**
 * The share page's player.
 *
 * A plain `<audio>` element with a custom control on top rather than a
 * synthesiser: the recipient should hear the sketch as its creator rendered it,
 * from one small file, with no model, no worker and no WebGL.
 *
 * `preload="metadata"` and no autoplay: an audio file that starts by itself
 * when a link opens is hostile, and browsers block it anyway (accessibility
 * skill: "do not autoplay surprising sound on page load").
 *
 * The play count is reported once per page, on first play, and carries nothing
 * but the id.
 */
export function SharePlayer({ id, audioUrl, durationSec, playLabel, pauseLabel }: SharePlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const counted = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setProgress(audio.duration > 0 ? audio.currentTime / audio.duration : 0);
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => {
        setPlaying(true);
        if (!counted.current) {
          counted.current = true;
          void fetch(`/api/share/${id}/played`, { method: 'POST', keepalive: true }).catch(
            () => undefined,
          );
        }
      });
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  return (
    <div className={styles.player}>
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      <button
        type="button"
        className={styles.playButton}
        onClick={toggle}
        aria-label={playing ? pauseLabel : playLabel}
      >
        {playing ? (
          <span className={styles.pauseGlyph} aria-hidden="true" />
        ) : (
          <span className={styles.playGlyph} aria-hidden="true" />
        )}
      </button>

      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ inlineSize: `${progress * 100}%` }} />
      </div>

      <span className={styles.duration}>
        {Math.floor(durationSec)}s
      </span>
    </div>
  );
}
