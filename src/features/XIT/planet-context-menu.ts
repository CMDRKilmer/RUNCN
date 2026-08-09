import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import PlanetMenu from './PlanetMenu.vue';

let clickOutsideListener: ((e: MouseEvent) => void) | null = null;
let isOpen = false;
let menuElement: HTMLElement | null = null;

function setLocation(event: MouseEvent) {
  if (menuElement === null) {
    return;
  }
  const parentRect = menuElement.parentElement!.getBoundingClientRect();
  const menuRect = menuElement.getBoundingClientRect();
  if (event.clientX + menuRect.width > parentRect.right) {
    store.menuStyle.left = (parentRect.right - menuRect.width).toString() + 'px';
  } else {
    store.menuStyle.left = event.clientX.toString() + 'px';
  }
  store.menuStyle.top = (event.clientY - menuRect.height).toString() + 'px';
}

export const store = reactive({
  naturalId: '',
  menuStyle: {
    display: 'none',
    left: '0px',
    top: '0px',
  },
  async showMenu(event: MouseEvent, naturalId: string) {
    if (clickOutsideListener !== null) {
      document.removeEventListener('click', clickOutsideListener);
      clickOutsideListener = null;
    }
    isOpen = true;
    this.naturalId = naturalId;
    this.menuStyle.display = 'block';
    await nextTick();
    setLocation(event);
    clickOutsideListener = (e: MouseEvent) => {
      if (menuElement !== null && !menuElement.contains(e.target as Node)) {
        store.hideMenu();
      }
    };
    document.addEventListener('click', clickOutsideListener);
  },
  hideMenu() {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    this.menuStyle.display = 'none';
    if (clickOutsideListener !== null) {
      document.removeEventListener('click', clickOutsideListener);
      clickOutsideListener = null;
    }
  },
  showBuffer(cmd: string) {
    this.hideMenu();
    showBuffer(`${cmd} ${this.naturalId}`);
  },
});

async function init() {
  const container = document.getElementById('container');
  if (container?.parentElement) {
    const componentInstance = createFragmentApp(PlanetMenu).appendTo(container);
    menuElement = componentInstance.$el as HTMLElement;
  }
}

features.add(
  import.meta.url,
  init,
  'Right-click planet cell in XIT BS/BURN to open PLI, COGC, POPR, POPI, or ADM.',
);
