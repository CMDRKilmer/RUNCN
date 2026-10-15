# resolveEntity 失败 —— 最可能根因（有代码证据，待一次实测确认）

## 高度可疑：匹配条件对空间站恒不成立

```ts
const hit = addresses.find(a => {
  const planet = a.lines.find(l => l.type === 'PLANET')?.entity;
  const stationLine = a.lines.find(l => l.type === 'STATION')?.entity;
  return (
    (planet?.naturalId.toUpperCase() === naturalId.toUpperCase())        // 行星：可比
    || (stationLine?.name.toUpperCase() === naturalId.toUpperCase())     // 空间站：拿「名字」比「naturalId」
  );
});
```

- 探针传的是 `HRT`（**naturalId**）；
- 空间站分支比的是 `stationLine.name`，即 `Hortus Station`；
- **`HORTUS STATION` !== `HRT`，恒不成立。**

⇒ 探针填**空间站**永远匹配不上；只有填**行星**（如 `VH-331g`，planet.naturalId 才对得上）才可能命中。

这与观测完全一致：面板报「无法解析」。

## 为什么这不只是我的扫描器的问题
`collectAllPlanetStl`（「采集全部星球 STL」）用的是**同一个** `resolveEntity`。
⇒ **那个按钮对空间站探针也应该一直失败**。这是既有缺陷，不是我引入的。
（它的默认探针是 `VH-192c` —— **行星**，所以一直没暴露。）

## 下一步（一次实测即可确认，不需要再猜）
把 FTC 面板里「探针」从 `HRT` 改成**行星** `VH-331g`（目标天体也换成同星系另一个天体），
再点「扫描 f 曲线」。
- 成功 ⟹ 确认是匹配 bug，修复：空间站分支应同时比 `naturalId` 与 `name`；
- 仍失败 ⟹ 才是 socket/registry 问题，再查那条线。

## 附带
已给 `resolveEntity` 加分级诊断（console.warn 区分无响应/不匹配），
刷新页面后点一次即可从 console 直接读到是哪种失败。
