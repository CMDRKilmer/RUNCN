import { sleep } from './sleep';

// Downloads a file containing fileData with fileName.
// When isJSON is true, fileData is serialized as JSON, otherwise it is written as plain text.
export function downloadFile(fileData: string | object, fileName: string, isJSON: boolean = true) {
  const content = isJSON ? JSON.stringify(fileData) : (fileData as string);
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  const urlElement = document.createElement('a');
  urlElement.setAttribute('download', fileName);
  urlElement.href = url;
  urlElement.setAttribute('target', '_blank');
  urlElement.click();
  URL.revokeObjectURL(url);
}

export function changeInputValue(input: HTMLInputElement, value: string) {
  // React overrides the native property, so we can't use it directly.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  setter!.set!.call(input, value);
  const event = new InputEvent('input', { bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  const changeEvent = new Event('change', { bubbles: true, cancelable: true });
  input.dispatchEvent(changeEvent);
}

export function changeSelectIndex(input: HTMLSelectElement, selectIndex: number) {
  // React overrides the native property, so we can't use it directly.
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'selectedIndex',
  );
  setter!.set!.call(input, selectIndex);
  const changeEvent = new Event('change', { bubbles: true, cancelable: true });
  input.dispatchEvent(changeEvent);
}

export function focusElement(input: HTMLElement) {
  const event = new FocusEvent('focusin', { bubbles: true, cancelable: false });
  input.dispatchEvent(event);
}

export async function clickElement(element?: HTMLElement | null) {
  if (!element) {
    return;
  }

  element.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );

  element.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );

  await sleep(0);

  element.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );

  element.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );

  element.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );

  window.getSelection()?.removeAllRanges();
}
