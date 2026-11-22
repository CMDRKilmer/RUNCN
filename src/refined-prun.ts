import '@src/refined-prun.css';

// token 主题的色板层，顺序跟随 theme-registry.ts 的主题列表；构建时与主样式表
// 合并为同一个 dist/refined-prun.css，首屏时序和各主题内部的规则次序都不变。
import '@src/features/basic/themes/light.css';
import '@src/features/basic/themes/paper.css';
import '@src/features/basic/themes/ceramic-colorful.css';
import '@src/features/basic/themes/claude.css';
import '@src/features/basic/themes/nebula.css';
import '@src/features/basic/themes/starforge.css';
import '@src/features/basic/themes/htb.css';

import '@src/infrastructure/shell';

import '@src/infrastructure/fio/routes';

import '@src/utils/dayjs';
import '@src/utils/chartjs-dayjs';

import '@src/features/basic';
import '@src/features/advanced';
import '@src/features/XIT';

import '@src/main';
