// Purpose is independent from image capability. General vision models may
// organize text too; dedicated OCR models must never become the text formatter.
export function profilePurpose(profile) {
  if (['text', 'ocr'].includes(profile?.purpose)) return profile.purpose;
  return /(?:^|[-_.])ocr(?:$|[-_.])/i.test(profile?.model || '') ? 'ocr' : 'text';
}

export function normalizeProfileRouting(profiles) {
  const items = profiles.items.map(p => ({ ...p, purpose: profilePurpose(p) }));
  const active = items.find(p => p.id === profiles.activeId);
  const visionId = items.some(p => p.id === profiles.visionId && p.vision) ? profiles.visionId
    : active?.vision && active.purpose === 'ocr' ? active.id : '';
  const activeId = active?.purpose === 'text' ? active.id : items.find(p => p.purpose === 'text')?.id || '';
  return { ...profiles, items, activeId, visionId };
}
