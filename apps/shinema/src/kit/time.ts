/** 0:24, 3:05 or 1:02:10, as a player shows it. */
export const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/** "1 h 7 min left", "18 min left" or "under a minute left". */
export const timeLeft = (seconds: number) => {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return 'under a minute left';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min left` : `${m} min left`;
};
