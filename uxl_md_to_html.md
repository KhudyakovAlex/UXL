## Инструкция для LLM: как UXL должен попадать из Markdown в HTML

Цель: на сайте, где исходник пишут в Markdown и затем конвертируют в HTML, UXL-блоки должны автоматически рендериться нашим движком в браузере.

### 1) Подключение актуального UXL-движка (брать из GitHub репозитория)

Есть два корректных способа брать **актуальные** версии из репозитория `KhudyakovAlex/UXL`:

- **Вариант A (рекомендую)**: скопировать `uxl.js` и `uxl.css` из GitHub-репозитория в проект сайта как статические файлы и подключать локально.
- **Вариант B**: подключать через GitHub‑CDN (jsDelivr), который берёт файлы из репозитория:
  - CSS: `https://cdn.jsdelivr.net/gh/KhudyakovAlex/UXL@main/uxl.css`
  - JS: `https://cdn.jsdelivr.net/gh/KhudyakovAlex/UXL@main/uxl.js`

> Не используй `raw.githubusercontent.com` напрямую в `<script src=...>`: в браузерах это часто ломается из‑за MIME-типа + `nosniff`.

В итоговом HTML добавь:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/KhudyakovAlex/UXL@main/uxl.css">
<script src="https://cdn.jsdelivr.net/gh/KhudyakovAlex/UXL@main/uxl.js"></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    // По умолчанию движок ищет pre.uxl-md-block и рендерит их содержимое
    window.UXL.renderAll({ selector: "pre.uxl-md-block", mode: "permissive" });
  });
</script>
```

### 2) Какой HTML должен получаться из Markdown для UXL-блоков

Наш рендерер читает **текст** из элементов, выбранных селектором (по умолчанию `pre.uxl-md-block`).
Внутри может быть:
- либо “чистый” UXL-текст (без ```),
- либо Markdown-текст, содержащий fenced-блоки ` ```UXL ... ``` ` (движок сам вытащит UXL).

Рекомендуемый формат в итоговом HTML для каждого UXL-блока:

```html
<pre class="uxl-md-block">400x700
P\home\Главная
  C\Текст
</pre>
```

### 3) Правило преобразования Markdown → HTML (обязательное)

Если в Markdown встречается fenced code block языка `UXL`/`uxl`:

````text
```UXL
...uxl text...
```
````

то при конвертации в HTML нужно обеспечить, что:
- содержимое UXL попадёт в DOM как **textContent** (без “тройных кавычек” и без лишнего экранирования),
- контейнер будет соответствовать селектору рендера: `pre.uxl-md-block`.

### 4) Если ваш Markdown-конвертер генерирует стандартный HTML `<pre><code class="language-uxl">...`

Многие конвертеры делают так:

```html
<pre><code class="language-uxl">400x700
P\home\Главная
</code></pre>
```

В этом случае добавь пост-обработку HTML (или DOM на клиенте), которая превращает такие блоки в нужный формат:

- Найти все `pre > code.language-uxl` и `pre > code.language-UXL`
- Для каждого:
  - взять `code.textContent` как исходный UXL-текст
  - заменить весь `<pre>` на:
    - `<pre class="uxl-md-block">...</pre>` (внутри именно текст UXL)

После этого `window.UXL.renderAll()` отрендерит их автоматически.

### 5) Важные требования к содержимому UXL (не ломать при конвертации)

- Сохраняй переводы строк и пробелы: вложенность задаётся **двумя пробелами**.
- Не заменяй обратный слэш `\` (это разделитель полей).
- Не подставляй/не удаляй ведущие пробелы строк внутри UXL.


