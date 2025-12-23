### UXL подсветка для Cursor (VS Code engine)

Это локальное расширение добавляет:
- Подсветку языка `uxl`
- Подсветку fenced-блоков в Markdown: ```UXL ... ```
- Подсветку fenced-блоков в HTML (например внутри `<pre>...</pre>`), если внутри есть строки ```UXL ... ```

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

- В HTML: если внутри текста есть такие же fenced-блоки (как в `index.html` проекта).


