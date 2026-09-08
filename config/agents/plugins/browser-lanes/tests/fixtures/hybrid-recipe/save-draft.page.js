export function saveDraftPage(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new TypeError('title is required');
  }
  const input = document.querySelector('[name="draft-title"]');
  const save = document.querySelector('[data-action="save-draft"]');
  if (!(input instanceof HTMLInputElement) || !(save instanceof HTMLElement)) {
    throw new Error('observed draft controls are unavailable');
  }
  input.value = title;
  save.click();
  return { title, saveRequested: true };
}
