export function useClipboard() {
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error('Failed to copy to clipboard', e);
    }
  }

  return { copy };
}
