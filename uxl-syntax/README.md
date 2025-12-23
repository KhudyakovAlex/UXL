### UXL подсветка для Cursor (VS Code engine)

Это локальное расширение добавляет:
- Подсветку языка `uxl`
- Подсветку fenced-блоков в Markdown: ```UXL ... ```
- Подсветку fenced-блоков в HTML (например внутри `<pre>...</pre>`), если внутри есть строки ```UXL ... ```
- Сворачивание (folding) страниц `P\...` внутри UXL-блоков в Markdown/HTML, и в файлах `.uxl`

### Установка

1) Собрать `.vsix`:

```bash
cd uxl-syntax
npx --yes @vscode/vsce package
```

2) Установить в Cursor:
- `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
- выбрать файл `uxl-syntax-0.0.1.vsix`
- перезапустить Cursor

### Использование

- В Markdown: fenced-блоки

```text
```UXL
P\home\Главная
  C\Текст
```
```

- В HTML: fenced-блоки внутри текста. Поддерживается как вариант с fence на отдельной строке, так и как в `index.html` проекта: `<pre ...>```UXL` и закрытие ` ```</pre>`.

### Folding (сворачивание страниц P)

После установки расширения можно сворачивать блоки `P\...` и контейнеры `F\...` прямо внутри UXL в:
- Markdown (внутри fenced ` ```UXL ... ``` `)
- HTML (если внутри текста есть такие же fenced-блоки)
- `.uxl` / `.uxl.txt`

Сворачивание — стандартное для редактора: кликом по стрелке в gutter слева или командами Fold/Unfold.

### Кастомизация цвета (тег P целиком)

Расширение задаёт дефолт (начиная с `0.0.3`):
- **`P\...`** — красным `#ff4d4d`
- **`F\...`** — голубым `#78c3ff`

Если захочешь поменять/отключить — в настройках Cursor/VS Code:

```json
"editor.tokenColorCustomizations": {
  "textMateRules": [
    {
      "scope": "meta.line.p.uxl",
      "settings": { "foreground": "#ff4d4d" }
    },
    {
      "scope": "meta.line.f.uxl",
      "settings": { "foreground": "#78c3ff" }
    }
  ]
}
```


