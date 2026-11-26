import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { esc, renderMarkdown } from "../src/ui/markdown.js";

describe("Markdown Renderer (XSS-safe)", () => {
  it("escapes HTML and XSS payloads everywhere", () => {
    assert.equal(esc(`<script>"a"&'b'</script>`), "&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;");

    const html = renderMarkdown(
      `Hello <script>alert(1)</script> and <img src=x onerror="alert(2)">\n\n请检查'quoted'和#12。\n\n\`\`\`html\n<svg onload=alert(3)>\n\`\`\``,
    );
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("<svg"), false);
    assert.ok(html.includes("&#39;quoted&#39;"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"));
    assert.ok(html.includes("&lt;svg onload=alert(3)&gt;"));
  });

  it("renders CJK-prefixed @mentions and clickable #seq pills without corrupting code or HTML entities", () => {
    const md = [
      "请@grok核查#12，也可参考@#backend及`inline #99 @raw`。",
      "",
      "## Summary Heading",
      "",
      "> Quoted note with **bold** and `inline @raw *star*`",
      "",
      "- **Item 1** for @coordinator [review_pass]",
      "- *Item 2* status [blocked]",
      "",
      "1. First step",
      "2. Second step [done]",
      "",
      "| File | Status |",
      "| :--- | :--- |",
      "| `src/ui/app.ts` | updated |",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const html = renderMarkdown(md);
    assert.ok(html.includes('<span class="md-mention">@grok</span>'));
    assert.ok(html.includes('<button type="button" class="md-seq-ref" data-action="scroll-seq" data-seq="12">#12</button>'));
    assert.ok(html.includes('<span class="md-mention">@#backend</span>'));
    assert.equal(html.includes('data-seq="99"'), false);
    assert.ok(html.includes('<div class="md-h md-h-2">Summary Heading</div>'));
    assert.ok(html.includes('<blockquote class="md-quote">'));
    assert.ok(html.includes('<code class="inline-code">inline @raw *star*</code>'));
    // Must NOT transform @raw or *star* inside inline code span
    assert.equal(html.includes('<span class="md-mention">@raw</span>'), false);
    assert.equal(html.includes("<em>star</em>"), false);
    assert.ok(html.includes("<strong>Item 1</strong>"));
    assert.ok(html.includes("<em>Item 2</em>"));
    assert.ok(html.includes('<span class="md-mention">@coordinator</span>'));
    assert.ok(html.includes('<span class="md-tag md-tag-review_pass">[review_pass]</span>'));
    assert.ok(html.includes('<span class="md-tag md-tag-blocked">[blocked]</span>'));
    assert.ok(html.includes('<span class="md-tag md-tag-done">[done]</span>'));
    assert.ok(html.includes('<ol class="md-list">'));
    assert.ok(html.includes('<table class="md-table">'));
    assert.ok(html.includes('<div class="md-code-lang">ts</div>'));
    assert.ok(html.includes('<pre class="md-pre"><code>const x = 1;</code></pre>'));
  });
});
